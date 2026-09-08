//! Isolated journal proof only. No Tauri app, official installer or server starts.
//! Default invocation only explains usage. Mutation requires a newly created,
//! empty private temp root; the CLI never resumes a record loaded from disk.

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "../src/updater_attempt.rs"]
// This standalone historical probe uses only the admission reader. The live
// successor/health journal is exercised by the application binary's tests.
#[allow(dead_code)]
mod updater_attempt;
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "support/updater_journal.rs"]
mod updater_journal;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    use updater_journal::{InstallerReturn, Journal};
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty() || args == ["--help"] {
        println!("QA journal proof only; no installation or G0 acceptance.\nUsage:\n  updater_journal_probe --fresh-qa-root /canonical/temp/gajae-updater-journal-XXXXXX --simulate retain|success|failure|cancelled|uncertain\n  updater_journal_probe --new-temp --simulate retain|success|failure|cancelled|uncertain\nExisting nonempty roots are never resumed or cleared.");
        return Ok(());
    }
    let (root, scenario) =
        if args.len() == 4 && args[0] == "--fresh-qa-root" && args[2] == "--simulate" {
            (Some(std::path::PathBuf::from(&args[1])), args[3].to_str())
        } else if args.len() == 3 && args[0] == "--new-temp" && args[1] == "--simulate" {
            (None, args[2].to_str())
        } else {
            return Err("Use --help; no mutation performed.".into());
        };
    let scenario = scenario
        .filter(|s| ["retain", "success", "failure", "cancelled", "uncertain"].contains(s))
        .ok_or("Unknown simulation; no mutation performed.")?;
    let root = match root {
        Some(root) => root,
        None => updater_journal::create_fresh_temp_root()?,
    };
    let journal = Journal::claim_fresh(&root)?;
    updater_attempt::check(&root)?;
    let sentinel = b"isolated QA target B -- not an installed app\n";
    let mut attempt = journal.begin(Sha256::digest(sentinel).into())?;
    if updater_attempt::check(&root).is_ok() {
        return Err("Guard disagreement after journal publication.".into());
    }
    let archive = match scenario {
        "success" => {
            attempt.write_qa_target(sentinel)?;
            attempt.record_installer_returned(InstallerReturn::Success)?;
            attempt.verify_target("qa-target.bin")?;
            Some(attempt.archive_verified()?.name)
        }
        "retain" => {
            drop(attempt);
            None
        }
        value => {
            attempt.record_installer_returned(match value {
                "failure" => InstallerReturn::Failed,
                "cancelled" => InstallerReturn::Cancelled,
                _ => InstallerReturn::Uncertain,
            })?;
            drop(attempt);
            None
        }
    };
    let blocked = updater_attempt::check(&root).is_err();
    if blocked == archive.is_some() {
        return Err("Guard disagreement after simulation.".into());
    }
    println!(
        "{}",
        serde_json::json!({
            "proof": "qa-journal-simulation-only", "root": root, "scenario": scenario,
            "startupBlocked": blocked, "archive": archive, "officialInstallerCalled": false,
            "osWriterTerminationProven": false, "g0Accepted": false,
            "sameUidConcurrentNamespaceMutationProven": false,
        })
    );
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn main() {
    println!("QA journal probe is unavailable on this platform. No mutation performed.");
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::{
        updater_attempt::{check, ATTEMPT_RECORD},
        updater_journal::{self, Error, InstallerReturn, Journal, SyncPoint},
    };
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        os::unix::fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    const TARGET: &[u8] = b"isolated target B fixture\n";
    fn digest() -> [u8; 32] {
        Sha256::digest(TARGET).into()
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(updater_journal::create_fresh_temp_root().unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            // Only directories allocated by this fixture; process children have been joined.
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn write_private(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn real_guard_agrees_before_publication_through_verified_archive() {
        let root = Temp::new();
        assert!(check(&root.0).is_ok());
        let journal = Journal::claim_fresh(&root.0).unwrap();
        assert!(check(&root.0).is_ok());
        let mut stages = Vec::new();
        let mut attempt = journal
            .begin_observed(digest(), |stage| {
                stages.push(stage);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            stages,
            [
                SyncPoint::Created,
                SyncPoint::BeforeFileSync,
                SyncPoint::FileSynced,
                SyncPoint::BeforeDirectorySync,
                SyncPoint::DirectorySynced
            ]
        );
        assert!(check(&root.0).is_err());
        attempt.write_qa_target(TARGET).unwrap();
        attempt
            .record_installer_returned(InstallerReturn::Success)
            .unwrap();
        assert!(check(&root.0).is_err());
        attempt.verify_target("qa-target.bin").unwrap();
        assert!(check(&root.0).is_err());
        let record = root.0.join(ATTEMPT_RECORD);
        let before = fs::read(&record).unwrap();
        let identity = fs::metadata(&record).unwrap();
        let archive = attempt.archive_verified().unwrap();
        assert!(check(&root.0).is_ok());
        let archived = root.0.join(archive.name);
        assert_eq!(fs::read(&archived).unwrap(), before);
        assert_eq!(fs::metadata(&archived).unwrap().ino(), identity.ino());
        assert_eq!(fs::metadata(&archived).unwrap().nlink(), 1);
    }

    #[test]
    fn failed_cancelled_uncertain_and_drop_keep_canonical_blocker() {
        for outcome in [
            None,
            Some(InstallerReturn::Failed),
            Some(InstallerReturn::Cancelled),
            Some(InstallerReturn::Uncertain),
            Some(InstallerReturn::Success),
        ] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let mut attempt = journal.begin(digest()).unwrap();
            if let Some(outcome) = outcome {
                attempt.record_installer_returned(outcome).unwrap();
            }
            drop(attempt);
            drop(journal);
            let bytes = fs::read(root.0.join(ATTEMPT_RECORD)).unwrap();
            assert!(check(&root.0).is_err());
            assert!(Journal::claim_fresh(&root.0).is_err());
            assert_eq!(fs::read(root.0.join(ATTEMPT_RECORD)).unwrap(), bytes);
        }
    }

    #[test]
    fn success_return_alone_or_version_flags_cannot_clear_admission() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let mut attempt = journal.begin(digest()).unwrap();
        attempt
            .record_installer_returned(InstallerReturn::Success)
            .unwrap();
        assert!(attempt.archive_verified().is_err());
        assert!(check(&root.0).is_err());
        for bytes in [b"".as_slice(), b"{", br#"{"installer_returned":true,"target_verified":true,"state":"relaunch","target_desktop_version":"0.2.4"}"#] {
            let other = Temp::new(); write_private(&other.0.join(ATTEMPT_RECORD), bytes);
            assert!(check(&other.0).is_err());
            assert!(Journal::claim_fresh(&other.0).is_err());
            assert_eq!(fs::read(other.0.join(ATTEMPT_RECORD)).unwrap(), bytes);
        }
    }

    #[test]
    fn failed_cancelled_or_uncertain_return_cannot_be_upgraded_by_later_booleans() {
        for outcome in [
            InstallerReturn::Failed,
            InstallerReturn::Cancelled,
            InstallerReturn::Uncertain,
        ] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let mut attempt = journal.begin(digest()).unwrap();
            attempt.record_installer_returned(outcome).unwrap();
            let before = fs::read(root.0.join(ATTEMPT_RECORD)).unwrap();
            assert_eq!(
                attempt.record_installer_returned(InstallerReturn::Success),
                Err(Error::WrongPhase)
            );
            assert_eq!(attempt.write_qa_target(TARGET), Err(Error::WrongPhase));
            assert_eq!(
                attempt.verify_target("qa-target.bin"),
                Err(Error::WrongPhase)
            );
            assert!(attempt.archive_verified().is_err());
            assert!(check(&root.0).is_err());
            assert_eq!(fs::read(root.0.join(ATTEMPT_RECORD)).unwrap(), before);
        }
    }

    #[test]
    fn existing_symlink_hardlink_and_nonregular_record_are_not_opened_for_writing() {
        for kind in ["symlink", "hardlink", "directory"] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let victim = root.0.join("keep.bin");
            write_private(&victim, b"keep exact bytes");
            let record = root.0.join(ATTEMPT_RECORD);
            match kind {
                "symlink" => symlink(&victim, &record).unwrap(),
                "hardlink" => fs::hard_link(&victim, &record).unwrap(),
                _ => fs::create_dir(&record).unwrap(),
            }
            assert!(matches!(
                journal.begin(digest()),
                Err(Error::AlreadyPresent)
            ));
            assert!(check(&root.0).is_err());
            assert_eq!(fs::read(victim).unwrap(), b"keep exact bytes");
        }
    }

    #[test]
    fn duplicate_attempts_do_not_replace_or_truncate_the_first() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let first = journal.begin(digest()).unwrap();
        let bytes = fs::read(root.0.join(ATTEMPT_RECORD)).unwrap();
        assert!(matches!(
            journal.begin(digest()),
            Err(Error::AlreadyPresent)
        ));
        assert!(Journal::claim_fresh(&root.0).is_err());
        drop(first);
        assert_eq!(fs::read(root.0.join(ATTEMPT_RECORD)).unwrap(), bytes);
        assert!(check(&root.0).is_err());
    }

    #[test]
    fn no_live_handle_or_target_mutation_before_both_sync_barriers() {
        for fault in [
            SyncPoint::Created,
            SyncPoint::BeforeFileSync,
            SyncPoint::FileSynced,
            SyncPoint::BeforeDirectorySync,
            SyncPoint::DirectorySynced,
        ] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let result = journal.begin_observed(digest(), |point| {
                if point == fault {
                    Err(Error::Injected)
                } else {
                    Ok(())
                }
            });
            let live = result.map(|attempt| attempt.write_qa_target(TARGET));
            assert!(matches!(live, Err(Error::Injected)));
            assert!(!root.0.join("qa-target.bin").exists());
            assert!(check(&root.0).is_err());
        }
    }

    #[test]
    fn truncated_state_write_poison_keeps_record_and_cannot_upgrade_to_success() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let mut attempt = journal.begin(digest()).unwrap();
        assert_eq!(
            attempt.returned_observed(InstallerReturn::Success, |point| {
                if point == SyncPoint::Truncated {
                    Err(Error::Injected)
                } else {
                    Ok(())
                }
            }),
            Err(Error::Injected)
        );
        assert_eq!(fs::metadata(root.0.join(ATTEMPT_RECORD)).unwrap().len(), 0);
        assert!(attempt.archive_verified().is_err());
        assert!(check(&root.0).is_err());
    }

    #[test]
    fn replaced_record_same_bytes_symlink_hardlink_or_foreign_mode_is_never_accepted() {
        for replacement in ["same-bytes", "symlink", "hardlink", "mode"] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let mut attempt = journal.begin(digest()).unwrap();
            let record = root.0.join(ATTEMPT_RECORD);
            let bytes = fs::read(&record).unwrap();
            let kept = root.0.join("owned-original.json");
            if replacement == "mode" {
                fs::set_permissions(&record, fs::Permissions::from_mode(0o644)).unwrap();
            } else {
                fs::rename(&record, &kept).unwrap();
                match replacement {
                    "same-bytes" => write_private(&record, &bytes),
                    "symlink" => symlink(&kept, &record).unwrap(),
                    _ => fs::hard_link(&kept, &record).unwrap(),
                }
            }
            assert!(attempt
                .record_installer_returned(InstallerReturn::Success)
                .is_err());
            assert!(attempt.archive_verified().is_err());
            assert!(check(&root.0).is_err());
            assert_eq!(fs::read(&record).unwrap(), bytes);
        }
    }

    #[test]
    fn target_verification_is_independent_and_rechecked_before_archive() {
        for change in [
            "wrong-bytes",
            "changed-after-verification",
            "replaced-same-bytes",
        ] {
            let root = Temp::new();
            let journal = Journal::claim_fresh(&root.0).unwrap();
            let mut attempt = journal.begin(digest()).unwrap();
            attempt
                .record_installer_returned(InstallerReturn::Success)
                .unwrap();
            attempt
                .write_qa_target(if change == "wrong-bytes" {
                    b"wrong"
                } else {
                    TARGET
                })
                .unwrap();
            if change == "wrong-bytes" {
                assert!(attempt.verify_target("qa-target.bin").is_err());
            } else {
                attempt.verify_target("qa-target.bin").unwrap();
                let target = root.0.join("qa-target.bin");
                if change == "changed-after-verification" {
                    fs::write(&target, b"changed").unwrap();
                } else {
                    fs::rename(&target, root.0.join("old-target.bin")).unwrap();
                    write_private(&target, TARGET);
                }
            }
            assert!(attempt.archive_verified().is_err());
            assert!(check(&root.0).is_err());
        }
    }

    #[test]
    fn fresh_root_rejects_symlink_alias_nonempty_wrong_mode_relative_and_parent_paths() {
        let root = Temp::new();
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Journal::claim_fresh(&root.0).is_err());
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = root.0.with_file_name(format!(
            "{}-alias",
            root.0.file_name().unwrap().to_str().unwrap()
        ));
        symlink(&root.0, &alias).unwrap();
        assert!(Journal::claim_fresh(&alias).is_err());
        fs::remove_file(alias).unwrap();
        assert!(Journal::claim_fresh(Path::new("relative")).is_err());
        assert!(Journal::claim_fresh(&root.0.join("..")).is_err());
        write_private(&root.0.join("keep"), b"unrelated");
        assert!(Journal::claim_fresh(&root.0).is_err());
        assert_eq!(fs::read(root.0.join("keep")).unwrap(), b"unrelated");
    }

    #[test]
    fn archive_destination_collision_never_overwrites_existing_entry() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let mut attempt = journal.begin(digest()).unwrap();
        attempt.write_qa_target(TARGET).unwrap();
        attempt
            .record_installer_returned(InstallerReturn::Success)
            .unwrap();
        attempt.verify_target("qa-target.bin").unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(root.0.join(ATTEMPT_RECORD)).unwrap()).unwrap();
        let name = format!(
            "desktop-update-attempt.{}.verified.json",
            value["attempt_id"].as_str().unwrap()
        );
        write_private(&root.0.join(&name), b"unrelated archive");
        assert!(attempt.archive_verified().is_err());
        assert_eq!(fs::read(root.0.join(name)).unwrap(), b"unrelated archive");
        assert!(check(&root.0).is_err());
    }

    fn child(root: &Temp, scenario: &str) -> std::process::ExitStatus {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::process_fault_child",
                "--ignored",
                "--nocapture",
            ])
            .env("GJC_JOURNAL_QA_ROOT", &root.0)
            .env("GJC_JOURNAL_FAULT", scenario)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("Owned QA child timed out.");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn process_faults_retain_blockers_and_never_resume_from_saved_success_flags() {
        for scenario in [
            "create",
            "before-file-sync",
            "file-synced",
            "directory-synced",
            "live",
            "truncated",
            "returned",
            "verified",
            "substituted",
        ] {
            let root = Temp::new();
            assert_eq!(
                child(&root, scenario).code(),
                Some(73),
                "scenario {scenario}"
            );
            assert!(check(&root.0).is_err(), "scenario {scenario}");
            assert!(Journal::claim_fresh(&root.0).is_err());
            if scenario != "verified" && scenario != "substituted" {
                assert!(!root.0.join("qa-target.bin").exists());
            }
        }
    }

    #[test]
    fn duplicate_process_cannot_claim_live_root() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let _attempt = journal.begin(digest()).unwrap();
        let before = fs::read(root.0.join(ATTEMPT_RECORD)).unwrap();
        assert_eq!(child(&root, "duplicate").code(), Some(74));
        assert!(check(&root.0).is_err());
        assert_eq!(fs::read(root.0.join(ATTEMPT_RECORD)).unwrap(), before);
    }

    #[test]
    fn forked_copy_is_not_the_live_owner() {
        let root = Temp::new();
        let journal = Journal::claim_fresh(&root.0).unwrap();
        let attempt = journal.begin(digest()).unwrap();
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            // No allocation/locks/filesystem operations in the forked child.
            unsafe { libc::_exit(if attempt.owner_pid_matches() { 1 } else { 0 }) };
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        assert!(check(&root.0).is_err());
    }

    #[test]
    #[ignore = "Only spawned with an explicitly fresh private QA root by process-fault tests"]
    fn process_fault_child() {
        let root = PathBuf::from(std::env::var_os("GJC_JOURNAL_QA_ROOT").expect("isolated root"));
        let scenario = std::env::var("GJC_JOURNAL_FAULT").expect("fault scenario");
        if scenario == "duplicate" {
            unsafe {
                libc::_exit(if Journal::claim_fresh(&root).is_err() {
                    74
                } else {
                    1
                })
            };
        }
        let journal = Journal::claim_fresh(&root).unwrap();
        let mut attempt = journal
            .begin_observed(digest(), |point| {
                let stop = matches!(
                    (scenario.as_str(), point),
                    ("create", SyncPoint::Created)
                        | ("before-file-sync", SyncPoint::BeforeFileSync)
                        | ("file-synced", SyncPoint::FileSynced)
                        | ("directory-synced", SyncPoint::DirectorySynced)
                );
                if stop {
                    unsafe { libc::_exit(73) };
                }
                Ok(())
            })
            .unwrap();
        if scenario == "live" {
            unsafe { libc::_exit(73) };
        }
        attempt
            .returned_observed(InstallerReturn::Success, |point| {
                if scenario == "truncated" && point == SyncPoint::Truncated {
                    unsafe { libc::_exit(73) };
                }
                Ok(())
            })
            .unwrap();
        if scenario == "returned" {
            unsafe { libc::_exit(73) };
        }
        if scenario == "verified" || scenario == "substituted" {
            attempt.write_qa_target(TARGET).unwrap();
            attempt.verify_target("qa-target.bin").unwrap();
            if scenario == "substituted" {
                let record = root.join(ATTEMPT_RECORD);
                let bytes = fs::read(&record).unwrap();
                fs::rename(&record, root.join("owned-before-substitution.json")).unwrap();
                write_private(&record, &bytes);
                assert!(attempt.archive_verified().is_err());
                assert_eq!(fs::read(&record).unwrap(), bytes);
                assert!(check(&root).is_err());
            }
            unsafe { libc::_exit(73) };
        }
        panic!("Unknown process fault scenario.");
    }
}
