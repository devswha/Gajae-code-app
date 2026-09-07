//! Initialize only a fresh, private updater QA profile without opening a window.
//! Reuses the application's profile guard; never manufactures its ownership marker.

#[cfg(target_os = "macos")]
#[path = "../src/macos_instance.rs"]
#[allow(dead_code)]
mod macos_instance;
#[cfg(target_os = "macos")]
#[path = "../src/qa_profile.rs"]
#[allow(dead_code)]
mod qa_profile;

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::MetadataExt;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("Usage: qa_profile_init /absolute/fresh/gajae-update-qa-*".into());
    }
    let root = std::path::PathBuf::from(&args[0]);
    let temp = std::env::temp_dir().canonicalize()?;
    let metadata = std::fs::symlink_metadata(&root)?;
    if root.parent() != Some(temp.as_path())
        || root.canonicalize()? != root
        || !root
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("gajae-update-qa-"))
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o700
        || std::fs::read_dir(&root)?.next().is_some()
    {
        return Err("Refusing a nonempty, foreign or noncanonical QA root.".into());
    }
    let os = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()?;
    if !os.status.success() {
        return Err("Could not verify QA OS support.".into());
    }
    qa_profile::require_supported_os(&String::from_utf8(os.stdout)?)?;
    let profile = qa_profile::QaProfile::open(&root)?;
    println!(
        "Initialized isolated updater QA profile: {}",
        profile.root().display()
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Updater QA profiles require macOS 14 or newer.");
    std::process::exit(1);
}
