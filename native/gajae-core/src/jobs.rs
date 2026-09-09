use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
const DEFAULT_REPLAY_BUDGET: u64 = 60 * 1024;
const DEFAULT_LIST_BUDGET: u64 = 48 * 1024;
const DEFAULT_CAPACITY: u64 = 4;

const MAX_RECONCILE_JOB_IDS: usize = 100;

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobActivity {
    schema_version: u8,
    reserved: u64,
    queued: u64,
    running: u64,
    aborting: u64,
    unknown: u64,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Reserved,
    Queued,
    Running,
    Aborting,
    Ready,
    Succeeded,
    Failed,
    Aborted,
    Interrupted,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ArchiveFilter {
    Exclude,
    Include,
    Only,
}

impl JobState {
    fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Reserved, Self::Queued)
                | (Self::Reserved, Self::Aborted)
                | (Self::Queued, Self::Running)
                | (Self::Queued, Self::Aborted)
                | (Self::Running, Self::Aborting)
                | (Self::Running, Self::Succeeded)
                | (Self::Running, Self::Failed)
                | (Self::Running, Self::Interrupted)
                | (Self::Aborting, Self::Aborted)
                | (Self::Aborting, Self::Succeeded)
                | (Self::Aborting, Self::Failed)
                | (Self::Aborting, Self::Interrupted)
                | (Self::Reserved, Self::Failed)
                | (Self::Queued, Self::Failed)
                | (Self::Ready, Self::Queued)
        )
    }
    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Aborted)
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Aborting => "aborting",
            Self::Ready => "ready",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
            Self::Interrupted => "interrupted",
        }
    }
    fn parse(value: &str) -> Result<Self, AuthorityError> {
        serde_json::from_value(Value::String(value.to_owned())).map_err(|_| AuthorityError::Storage)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    owner: String,
    generation: u64,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    sequence: u64,
    event_id: String,
    payload: Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalEvent {
    event_id: String,
    payload: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelAdmissionResult {
    #[serde(flatten)]
    snapshot: JobSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_event: Option<JobEvent>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    job_id: String,
    provider: String,
    state: JobState,
    lease: Option<Lease>,
    last_sequence: u64,
    worktree_id: Option<String>,
    branch: Option<String>,
    base_commit: Option<String>,
    repository_root: Option<String>,
    created_at: String,
    prompt: Option<String>,
    current_run: Option<CurrentRun>,
    dispatch_checkpoint: Option<DispatchCheckpoint>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentRun {
    run_id: String,
    app_session_id: Option<String>,
    provider_session_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchCheckpoint {
    run_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconcileResult {
    changed_count: u64,
    job_ids: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingResolution {
    job_id: String,
    state: JobState,
    provider_session_id: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Replay {
    events: Vec<JobEvent>,
    next_cursor: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobList {
    items: Vec<JobSnapshot>,
    next_cursor: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AuthorityError {
    InvalidIdentifier,
    AlreadyExists,
    NotFound,
    LeaseHeld,
    StaleLease,
    InvalidTransition,
    TerminalJob,
    EventConflict,
    CapacityExhausted,
    WorktreeConflict,
    Storage,
    AuthorityHeld,
}

struct PersistentAuthority {
    _lock: AuthorityLock,
    connection: Connection,
}

struct AuthorityLock {
    _connection: Connection,
}

impl AuthorityLock {
    fn acquire(database: &Path) -> Result<Self, AuthorityError> {
        let mut lock_path = database.as_os_str().to_os_string();
        lock_path.push(".lock");
        let connection =
            Connection::open(PathBuf::from(lock_path)).map_err(|_| AuthorityError::Storage)?;
        connection
            .busy_timeout(Duration::ZERO)
            .map_err(|_| AuthorityError::Storage)?;
        connection
            .pragma_update(None, "locking_mode", "EXCLUSIVE")
            .map_err(map_authority_lock_error)?;
        connection
            .execute_batch("BEGIN EXCLUSIVE; COMMIT;")
            .map_err(map_authority_lock_error)?;
        Ok(Self {
            _connection: connection,
        })
    }
}

fn map_authority_lock_error(error: rusqlite::Error) -> AuthorityError {
    match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            AuthorityError::AuthorityHeld
        }
        _ => AuthorityError::Storage,
    }
}

impl PersistentAuthority {
    /// One read-only aggregate over ALL durable ownership, including archived
    /// jobs and orphan nonterminal runs. No pagination, reconciliation or writes.
    fn activity(&self) -> Result<JobActivity, AuthorityError> {
        let mut statement = self.connection.prepare(
            "SELECT state,COUNT(*) FROM (SELECT state FROM jobs UNION ALL SELECT state FROM runs) GROUP BY state",
        ).map_err(|_| AuthorityError::Storage)?;
        let mut rows = statement.query([]).map_err(|_| AuthorityError::Storage)?;
        let mut result = JobActivity {
            schema_version: 1,
            ..JobActivity::default()
        };
        while let Some(row) = rows.next().map_err(|_| AuthorityError::Storage)? {
            let state: String = row.get(0).map_err(|_| AuthorityError::Storage)?;
            let count: u64 = row.get(1).map_err(|_| AuthorityError::Storage)?;
            match state.as_str() {
                "reserved" => result.reserved += count,
                "queued" => result.queued += count,
                "running" => result.running += count,
                "aborting" => result.aborting += count,
                "ready" | "succeeded" | "failed" | "aborted" | "interrupted" => {}
                _ => result.unknown += count,
            }
        }
        Ok(result)
    }

    fn open(path: &Path) -> Result<Self, AuthorityError> {
        let path = validate_database_path(path)?;
        let lock = AuthorityLock::acquire(&path)?;
        let mut connection = Connection::open(path).map_err(|_| AuthorityError::Storage)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| AuthorityError::Storage)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|_| AuthorityError::Storage)?;
        connection
            .pragma_update(None, "busy_timeout", 5_000_i64)
            .map_err(|_| AuthorityError::Storage)?;
        migrate(&mut connection)?;
        let mut authority = Self {
            _lock: lock,
            connection,
        };
        authority.reconcile()?;
        Ok(authority)
    }

    fn acquire(&mut self, id: &str, owner: &str) -> Result<Lease, AuthorityError> {
        validate_id(owner)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        let (state, held, generation): (String, Option<String>, u64) = tx
            .query_row(
                "SELECT state, lease_owner, next_lease_generation FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| AuthorityError::Storage)?
            .ok_or(AuthorityError::NotFound)?;
        let state = JobState::parse(&state)?;
        if state.is_terminal() {
            return Err(AuthorityError::TerminalJob);
        }
        if state == JobState::Interrupted {
            return Err(AuthorityError::InvalidTransition);
        }
        if held.is_some() {
            return Err(AuthorityError::LeaseHeld);
        }
        tx.execute("UPDATE jobs SET lease_owner=?2, lease_generation=?3, next_lease_generation=?4 WHERE id=?1", params![id, owner, generation, generation + 1]).map_err(|_| AuthorityError::Storage)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(Lease {
            owner: owner.to_owned(),
            generation,
        })
    }
    fn transition(
        &mut self,
        id: &str,
        lease: &Lease,
        next: JobState,
    ) -> Result<JobSnapshot, AuthorityError> {
        if next.is_terminal() {
            return Err(AuthorityError::InvalidTransition);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        let state = state(&tx, id)?;
        if !state.can_transition_to(next) {
            return Err(AuthorityError::InvalidTransition);
        }
        if next == JobState::Interrupted {
            tx.execute(
                "UPDATE jobs SET state=?2, lease_owner=NULL WHERE id=?1",
                params![id, next.as_str()],
            )
        } else {
            tx.execute(
                "UPDATE jobs SET state=?2 WHERE id=?1",
                params![id, next.as_str()],
            )
        }
        .map_err(|_| AuthorityError::Storage)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn append_event(
        &mut self,
        id: &str,
        lease: &Lease,
        event_id: &str,
        payload: Value,
    ) -> Result<JobEvent, AuthorityError> {
        validate_id(event_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        let event = append(&tx, id, event_id, &payload)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(event)
    }
    fn append_admin_event(
        &mut self,
        id: &str,
        event_id: &str,
        payload: Value,
    ) -> Result<JobEvent, AuthorityError> {
        validate_id(event_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        // Administrative events are post-run records. A leased job may still be
        // emitting run events, so never permit this bypass while a run is active.
        if state(&tx, id)? != JobState::Ready {
            return Err(AuthorityError::InvalidTransition);
        }
        let event = append(&tx, id, event_id, &payload)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(event)
    }
    fn append_event_for_run(
        &mut self,
        id: &str,
        lease: &Lease,
        run_id: &str,
        event_id: &str,
        payload: Value,
    ) -> Result<JobEvent, AuthorityError> {
        validate_id(run_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        verify_current_run(&tx, id, run_id)?;
        let event = append_for_run(&tx, id, run_id, event_id, &payload)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(event)
    }
    fn finalize(
        &mut self,
        id: &str,
        lease: &Lease,
        event_id: &str,
        payload: Value,
        next: JobState,
    ) -> Result<JobSnapshot, AuthorityError> {
        if !next.is_terminal() {
            return Err(AuthorityError::InvalidTransition);
        }
        validate_id(event_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        let current = state(&tx, id)?;
        if !current.can_transition_to(next) {
            return Err(AuthorityError::InvalidTransition);
        }
        append(&tx, id, event_id, &payload)?;
        tx.execute(
            "UPDATE jobs SET state=?2, lease_owner=NULL WHERE id=?1",
            params![id, next.as_str()],
        )
        .map_err(|_| AuthorityError::Storage)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn cancel_admission(
        &mut self,
        id: &str,
        lease: &Lease,
        event_id: &str,
        payload: Value,
        terminal_event: Option<TerminalEvent>,
    ) -> Result<CancelAdmissionResult, AuthorityError> {
        validate_id(event_id)?;
        if let Some(event) = &terminal_event {
            validate_id(&event.event_id)?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        if !matches!(state(&tx, id)?, JobState::Reserved | JobState::Queued) {
            return Err(AuthorityError::InvalidTransition);
        }
        append(&tx, id, event_id, &payload)?;
        let terminal_event = terminal_event
            .as_ref()
            .map(|event| append(&tx, id, &event.event_id, &event.payload))
            .transpose()?;
        tx.execute(
            "UPDATE runs SET state='failed',outcome='failed' WHERE job_id=?1 AND state NOT IN ('succeeded','failed','aborted','interrupted')",
            [id],
        )
        .map_err(|_| AuthorityError::Storage)?;
        tx.execute(
            "UPDATE session_job_bindings SET released_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND released_at IS NULL",
            [id],
        )
        .map_err(|_| AuthorityError::Storage)?;
        tx.execute(
            "UPDATE jobs SET state='failed',lease_owner=NULL WHERE id=?1",
            [id],
        )
        .map_err(|_| AuthorityError::Storage)?;
        let snapshot = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(CancelAdmissionResult {
            snapshot,
            terminal_event,
        })
    }
    fn replay(
        &self,
        id: &str,
        after: u64,
        budget: u64,
        response_id: &str,
    ) -> Result<Replay, AuthorityError> {
        if !exists(&self.connection, id)? {
            return Err(AuthorityError::NotFound);
        }
        let mut statement = self.connection.prepare("SELECT sequence,event_id,payload FROM job_events WHERE job_id=?1 AND sequence>?2 ORDER BY sequence").map_err(|_| AuthorityError::Storage)?;
        let mut rows = statement
            .query(params![id, after])
            .map_err(|_| AuthorityError::Storage)?;
        let mut events = Vec::new();
        while let Some(row) = rows.next().map_err(|_| AuthorityError::Storage)? {
            let event = event_from_row(row).map_err(|_| AuthorityError::Storage)?;
            let sequence = event.sequence;
            let mut candidate = events.clone();
            candidate.push(event);
            let has_more: bool = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM job_events WHERE job_id=?1 AND sequence>?2)",
                    params![id, sequence],
                    |r| r.get(0),
                )
                .map_err(|_| AuthorityError::Storage)?;
            let candidate_replay = Replay {
                events: candidate,
                next_cursor: has_more.then_some(sequence),
            };
            let size = replay_response_size(response_id, &candidate_replay)?;
            if !events.is_empty() && size > budget {
                break;
            }
            if size > MAX_FRAME_BYTES as u64 + 1 {
                return Err(AuthorityError::Storage);
            }
            events = candidate_replay.events;
        }
        let next_cursor = if let Some(last) = events.last() {
            self.connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM job_events WHERE job_id=?1 AND sequence>?2)",
                    params![id, last.sequence],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|_| AuthorityError::Storage)?
                .then_some(last.sequence)
        } else {
            None
        };
        Ok(Replay {
            events,
            next_cursor,
        })
    }
    #[cfg(test)]
    fn list(
        &self,
        state_filter: Option<JobState>,
        provider: Option<&str>,
        after: Option<&str>,
        limit: u64,
        budget: u64,
    ) -> Result<JobList, AuthorityError> {
        self.list_filtered(
            state_filter,
            provider,
            after,
            limit,
            budget,
            ArchiveFilter::Exclude,
        )
    }
    fn list_filtered(
        &self,
        state_filter: Option<JobState>,
        provider: Option<&str>,
        after: Option<&str>,
        limit: u64,
        budget: u64,
        archived: ArchiveFilter,
    ) -> Result<JobList, AuthorityError> {
        if !(1..=100).contains(&limit) {
            return Err(AuthorityError::InvalidIdentifier);
        }
        if let Some(value) = provider {
            validate_id(value)?;
        }
        if let Some(value) = after {
            validate_id(value)?;
        }
        let state_value = state_filter.map(JobState::as_str);
        let archived = match archived {
            ArchiveFilter::Exclude => "exclude",
            ArchiveFilter::Include => "include",
            ArchiveFilter::Only => "only",
        };
        let after = after.unwrap_or("");
        let mut statement = self.connection.prepare("SELECT j.id,j.provider,j.state,j.lease_owner,j.lease_generation,j.worktree_id,j.branch,j.base_commit,j.repository_root,COALESCE(MAX(e.sequence),0),(SELECT run_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT app_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT provider_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT dispatched_at FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),j.created_at,SUBSTR(j.prompt,1,256) FROM jobs j LEFT JOIN job_events e ON e.job_id=j.id WHERE (?1 IS NULL OR j.state=?1) AND (?2 IS NULL OR j.provider=?2) AND j.id>?3 AND (?4='include' OR (?4='exclude' AND j.archived_at IS NULL) OR (?4='only' AND j.archived_at IS NOT NULL)) GROUP BY j.id ORDER BY j.id LIMIT ?5").map_err(|_| AuthorityError::Storage)?;
        let mut rows = statement
            .query(params![state_value, provider, after, archived, limit + 1])
            .map_err(|_| AuthorityError::Storage)?;
        let mut list = JobList {
            items: Vec::new(),
            next_cursor: None,
        };
        let mut item_bytes = 0;
        while let Some(row) = rows.next().map_err(|_| AuthorityError::Storage)? {
            if list.items.len() == limit as usize {
                list.next_cursor = list.items.last().map(|item| item.job_id.clone());
                break;
            }
            let item = snapshot_from_row(row).map_err(|_| AuthorityError::Storage)?;
            let item_size = serde_json::to_vec(&item)
                .map_err(|_| AuthorityError::Storage)?
                .len() as u64;
            if !list.items.is_empty() && item_bytes + item_size > budget {
                list.next_cursor = list.items.last().map(|item| item.job_id.clone());
                break;
            }
            item_bytes += item_size;
            list.items.push(item);
        }
        Ok(list)
    }
    fn archive(&mut self, id: &str) -> Result<JobSnapshot, AuthorityError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        if matches!(
            state(&tx, id)?,
            JobState::Reserved | JobState::Queued | JobState::Running | JobState::Aborting
        ) {
            return Err(AuthorityError::InvalidTransition);
        }
        tx.execute(
            "UPDATE jobs SET archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP) WHERE id=?1",
            [id],
        )
        .map_err(|_| AuthorityError::Storage)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn unarchive(&mut self, id: &str) -> Result<JobSnapshot, AuthorityError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        state(&tx, id)?;
        tx.execute("UPDATE jobs SET archived_at=NULL WHERE id=?1", [id])
            .map_err(|_| AuthorityError::Storage)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn reserve(
        &mut self,
        id: &str,
        provider: &str,
        owner: &str,
        cap: u64,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(id)?;
        validate_id(provider)?;
        validate_id(owner)?;
        if !(1..=64).contains(&cap) {
            return Err(AuthorityError::InvalidIdentifier);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        let existing: Option<(String, String)> = tx
            .query_row("SELECT provider,state FROM jobs WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|_| AuthorityError::Storage)?;
        let count = consuming_count(&tx)?;
        match existing {
            Some(_) => return Err(AuthorityError::AlreadyExists),
            None if count >= cap => return Err(AuthorityError::CapacityExhausted),
            None => {
                tx.execute("INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,?2,'reserved',?3,1,2)", params![id, provider, owner]).map_err(map_insert)?;
            }
        }
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn readmit(
        &mut self,
        id: &str,
        owner: &str,
        run_id: &str,
        app_session_id: &str,
        cap: u64,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(id)?;
        validate_id(owner)?;
        validate_id(run_id)?;
        validate_id(app_session_id)?;
        if !(1..=64).contains(&cap) {
            return Err(AuthorityError::InvalidIdentifier);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        let (current, lease_owner, generation): (String, Option<String>, u64) = tx
            .query_row(
                "SELECT state,lease_owner,next_lease_generation FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| AuthorityError::Storage)?
            .ok_or(AuthorityError::NotFound)?;
        if JobState::parse(&current)? != JobState::Interrupted || lease_owner.is_some() {
            return Err(AuthorityError::InvalidTransition);
        }
        let has_binding: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_job_bindings WHERE job_id=?1 AND released_at IS NULL)", [id], |r| r.get(0)).map_err(|_| AuthorityError::Storage)?;
        let matching_binding: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_job_bindings WHERE job_id=?1 AND app_session_id=?2 AND released_at IS NULL)", params![id, app_session_id], |r| r.get(0)).map_err(|_| AuthorityError::Storage)?;
        if has_binding && !matching_binding {
            return Err(AuthorityError::InvalidTransition);
        }
        if consuming_count(&tx)? >= cap {
            return Err(AuthorityError::CapacityExhausted);
        }
        tx.execute("UPDATE jobs SET state='queued',lease_owner=?2,lease_generation=?3,next_lease_generation=?4 WHERE id=?1", params![id, owner, generation, generation + 1]).map_err(|_| AuthorityError::Storage)?;
        insert_run(&tx, id, run_id, app_session_id)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn prepare(
        &mut self,
        id: &str,
        lease: &Lease,
        worktree_id: &str,
        branch: &str,
        base_commit: &str,
        repository_root: &str,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_worktree_id(worktree_id)?;
        validate_branch(branch)?;
        validate_id(base_commit)?;
        validate_worktree_id(repository_root)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        if state(&tx, id)? != JobState::Reserved {
            return Err(AuthorityError::InvalidTransition);
        }
        let binding: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = tx
            .query_row(
                "SELECT worktree_id,branch,base_commit,repository_root FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| AuthorityError::Storage)?;
        match binding {
            (None, None, None, None) => {
                tx.execute(
                    "UPDATE jobs SET worktree_id=?2,branch=?3,base_commit=?4,repository_root=?5 WHERE id=?1",
                    params![id, worktree_id, branch, base_commit, repository_root],
                )
                .map_err(|_| AuthorityError::Storage)?;
            }
            (
                Some(worktree),
                Some(existing_branch),
                Some(existing_base_commit),
                Some(existing_repository_root),
            ) if worktree == worktree_id
                && existing_branch == branch
                && existing_base_commit == base_commit
                && existing_repository_root == repository_root => {}
            _ => return Err(AuthorityError::WorktreeConflict),
        }
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn admit(
        &mut self,
        id: &str,
        lease: &Lease,
        run_id: &str,
        app_session_id: &str,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(run_id)?;
        validate_id(app_session_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        let current = state(&tx, id)?;
        let binding: (Option<String>, Option<String>) = tx
            .query_row(
                "SELECT worktree_id,branch FROM jobs WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AuthorityError::Storage)?;
        if binding.0.is_none() || binding.1.is_none() {
            return Err(AuthorityError::WorktreeConflict);
        }
        if current == JobState::Reserved {
            tx.execute("UPDATE jobs SET state='queued' WHERE id=?1", [id])
                .map_err(|_| AuthorityError::Storage)?;
            insert_run(&tx, id, run_id, app_session_id)?;
        } else if current != JobState::Queued || !same_run(&tx, id, run_id, app_session_id)? {
            return Err(AuthorityError::InvalidTransition);
        }
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn bind_provider_session(
        &mut self,
        id: &str,
        lease: &Lease,
        run_id: &str,
        provider_session_id: &str,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(run_id)?;
        validate_id(provider_session_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        verify_current_run(&tx, id, run_id)?;
        let existing: Option<Option<String>> = tx
            .query_row(
                "SELECT provider_session_id FROM runs WHERE run_id=?1 AND job_id=?2",
                params![run_id, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| AuthorityError::Storage)?;
        match existing {
            Some(None) => {
                tx.execute(
                    "UPDATE runs SET provider_session_id=?3 WHERE run_id=?1 AND job_id=?2",
                    params![run_id, id, provider_session_id],
                )
                .map_err(|_| AuthorityError::Storage)?;
            }
            Some(Some(value)) if value == provider_session_id => {}
            _ => return Err(AuthorityError::InvalidTransition),
        }
        let app_session_id: Option<String> = tx
            .query_row(
                "SELECT app_session_id FROM runs WHERE run_id=?1 AND job_id=?2",
                params![run_id, id],
                |r| r.get(0),
            )
            .map_err(|_| AuthorityError::Storage)?;
        if let Some(app_session_id) = app_session_id {
            tx.execute("UPDATE session_job_bindings SET provider_session_id=?3 WHERE job_id=?1 AND app_session_id=?2 AND released_at IS NULL", params![id, app_session_id, provider_session_id]).map_err(|_| AuthorityError::Storage)?;
        }
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn mark_dispatching(
        &mut self,
        id: &str,
        lease: &Lease,
        run_id: &str,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(run_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        verify_current_run(&tx, id, run_id)?;
        if !matches!(state(&tx, id)?, JobState::Queued | JobState::Running) {
            return Err(AuthorityError::InvalidTransition);
        }
        let updated = tx
            .execute(
                "UPDATE runs SET dispatched_at=COALESCE(dispatched_at,CURRENT_TIMESTAMP) WHERE run_id=?1 AND job_id=?2",
                params![run_id, id],
            )
            .map_err(|_| AuthorityError::Storage)?;
        if updated != 1 {
            return Err(AuthorityError::InvalidTransition);
        }
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn reserve_start(
        &mut self,
        id: &str,
        provider: &str,
        app_session_id: &str,
        owner: &str,
        prompt: Option<&str>,
        cap: u64,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(id)?;
        validate_id(provider)?;
        validate_id(app_session_id)?;
        validate_id(owner)?;
        let prompt = prompt.map(validate_prompt).transpose()?;
        if !(1..=64).contains(&cap) {
            return Err(AuthorityError::InvalidIdentifier);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        if consuming_count(&tx)? >= cap {
            return Err(AuthorityError::CapacityExhausted);
        }
        let existing: Option<String> = tx
            .query_row("SELECT state FROM jobs WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(|_| AuthorityError::Storage)?;
        match existing.as_deref() {
            None => {
                tx.execute("INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation,prompt) VALUES(?1,?2,'reserved',?3,1,2,?4)", params![id, provider, owner, prompt]).map_err(map_insert)?;
            }
            _ => return Err(AuthorityError::AlreadyExists),
        }
        tx.execute(
            "INSERT INTO session_job_bindings(provider,app_session_id,job_id) VALUES(?1,?2,?3)",
            params![provider, app_session_id, id],
        )
        .map_err(map_insert)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn turn_admit(
        &mut self,
        id: &str,
        app_session_id: &str,
        owner: &str,
        run_id: &str,
        cap: u64,
    ) -> Result<JobSnapshot, AuthorityError> {
        validate_id(id)?;
        validate_id(app_session_id)?;
        validate_id(owner)?;
        validate_id(run_id)?;
        if !(1..=64).contains(&cap) {
            return Err(AuthorityError::InvalidIdentifier);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        if state(&tx, id)? != JobState::Ready {
            return Err(AuthorityError::InvalidTransition);
        }
        if consuming_count(&tx)? >= cap {
            return Err(AuthorityError::CapacityExhausted);
        }
        let bound: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_job_bindings WHERE job_id=?1 AND app_session_id=?2 AND released_at IS NULL)", params![id, app_session_id], |r| r.get(0)).map_err(|_| AuthorityError::Storage)?;
        if !bound {
            return Err(AuthorityError::InvalidTransition);
        }
        let generation: u64 = tx
            .query_row(
                "SELECT next_lease_generation FROM jobs WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| AuthorityError::Storage)?;
        tx.execute("UPDATE jobs SET state='queued',lease_owner=?2,lease_generation=?3,next_lease_generation=?4 WHERE id=?1", params![id, owner, generation, generation + 1]).map_err(|_| AuthorityError::Storage)?;
        insert_run(&tx, id, run_id, app_session_id)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn finalize_run(
        &mut self,
        id: &str,
        lease: &Lease,
        run_id: &str,
        next: JobState,
        event_id: &str,
        payload: Value,
    ) -> Result<JobSnapshot, AuthorityError> {
        if !matches!(
            next,
            JobState::Succeeded | JobState::Failed | JobState::Aborted | JobState::Interrupted
        ) {
            return Err(AuthorityError::InvalidTransition);
        }
        validate_id(run_id)?;
        validate_id(event_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        verify_lease(&tx, id, lease)?;
        verify_current_run(&tx, id, run_id)?;
        let updated = tx.execute("UPDATE runs SET state=?3,outcome=?3 WHERE run_id=?1 AND job_id=?2 AND state NOT IN ('succeeded','failed','aborted','interrupted')", params![run_id, id, next.as_str()]).map_err(|_| AuthorityError::Storage)?;
        if updated != 1 {
            return Err(AuthorityError::InvalidTransition);
        }
        append_for_run(&tx, id, run_id, event_id, &payload)?;
        let job_state = if next == JobState::Interrupted {
            "interrupted"
        } else {
            "ready"
        };
        tx.execute(
            "UPDATE jobs SET state=?2,lease_owner=NULL WHERE id=?1",
            params![id, job_state],
        )
        .map_err(|_| AuthorityError::Storage)?;
        let result = snapshot_tx(&tx, id)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(result)
    }
    fn resolve_binding(
        &self,
        provider: &str,
        app_session_id: &str,
    ) -> Result<BindingResolution, AuthorityError> {
        validate_id(provider)?;
        validate_id(app_session_id)?;
        self.connection.query_row("SELECT b.job_id,j.state,b.provider_session_id FROM session_job_bindings b JOIN jobs j ON j.id=b.job_id WHERE b.provider=?1 AND b.app_session_id=?2 AND b.released_at IS NULL", params![provider, app_session_id], |r| Ok(BindingResolution { job_id: r.get(0)?, state: JobState::parse(&r.get::<_, String>(1)?).map_err(|_| rusqlite::Error::InvalidQuery)?, provider_session_id: r.get(2)? })).optional().map_err(|_| AuthorityError::Storage)?.ok_or(AuthorityError::NotFound)
    }
    fn release_binding(&mut self, id: &str) -> Result<(), AuthorityError> {
        let updated = self.connection.execute("UPDATE session_job_bindings SET released_at=CURRENT_TIMESTAMP WHERE job_id=?1 AND released_at IS NULL", [id]).map_err(|_| AuthorityError::Storage)?;
        if updated != 1 {
            return Err(AuthorityError::NotFound);
        }
        Ok(())
    }
    fn interrupt_for_shutdown(&mut self) -> Result<ReconcileResult, AuthorityError> {
        self.reconcile()
    }
    fn reconcile(&mut self) -> Result<ReconcileResult, AuthorityError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthorityError::Storage)?;
        let changed_count = consuming_count(&tx)?;
        let mut job_ids = Vec::new();
        {
            let mut st = tx
            .prepare("SELECT id FROM jobs WHERE state IN ('reserved','queued','running','aborting') ORDER BY id LIMIT ?1")
            .map_err(|_| AuthorityError::Storage)?;
            let rows = st
                .query_map([MAX_RECONCILE_JOB_IDS], |r| r.get::<_, String>(0))
                .map_err(|_| AuthorityError::Storage)?;
            for id in rows {
                job_ids.push(id.map_err(|_| AuthorityError::Storage)?);
            }
        }
        let active_runs: Vec<(String, String)> = {
            let mut st = tx
            .prepare("SELECT r.run_id,r.job_id FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.state IN ('queued','running','aborting') AND r.state NOT IN ('succeeded','failed','aborted','interrupted')")
            .map_err(|_| AuthorityError::Storage)?;
            let rows = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|_| AuthorityError::Storage)?;
            rows.collect::<Result<_, _>>()
                .map_err(|_| AuthorityError::Storage)?
        };
        for (run_id, job_id) in active_runs {
            let event_id = format!("shutdown-interrupted:{run_id}");
            append(
                &tx,
                &job_id,
                &event_id,
                &serde_json::json!({"type":"interrupted","reason":"shutdown"}),
            )?;
            tx.execute(
                "UPDATE job_events SET run_id=?3 WHERE job_id=?1 AND event_id=?2",
                params![job_id, event_id, run_id],
            )
            .map_err(|_| AuthorityError::Storage)?;
            tx.execute(
            "UPDATE runs SET state='interrupted',outcome='interrupted' WHERE run_id=?1 AND job_id=?2 AND state NOT IN ('succeeded','failed','aborted','interrupted')",
            params![run_id, job_id],
        )
        .map_err(|_| AuthorityError::Storage)?;
        }
        tx.execute(
        "UPDATE jobs SET state='interrupted',lease_owner=NULL WHERE state IN ('reserved','queued','running','aborting')",
        [],
    )
    .map_err(|_| AuthorityError::Storage)?;
        tx.commit().map_err(|_| AuthorityError::Storage)?;
        Ok(ReconcileResult {
            changed_count,
            job_ids,
        })
    }
    fn snapshot(&self, id: &str) -> Result<JobSnapshot, AuthorityError> {
        snapshot_connection(&self.connection, id)
    }
}
fn consuming_count(tx: &Transaction<'_>) -> Result<u64, AuthorityError> {
    tx.query_row(
        "SELECT COUNT(*) FROM jobs WHERE state IN ('reserved','queued','running','aborting')",
        [],
        |r| r.get(0),
    )
    .map_err(|_| AuthorityError::Storage)
}
fn insert_run(
    tx: &Transaction<'_>,
    id: &str,
    run_id: &str,
    app_session_id: &str,
) -> Result<(), AuthorityError> {
    tx.execute(
        "INSERT INTO runs(run_id,job_id,app_session_id) VALUES(?1,?2,?3)",
        params![run_id, id, app_session_id],
    )
    .map_err(map_insert)?;
    Ok(())
}
fn same_run(
    tx: &Transaction<'_>,
    id: &str,
    run_id: &str,
    app_session_id: &str,
) -> Result<bool, AuthorityError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE run_id=?1 AND job_id=?2 AND app_session_id=?3)",
        params![run_id, id, app_session_id],
        |r| r.get(0),
    )
    .map_err(|_| AuthorityError::Storage)
}
fn verify_lease(tx: &Transaction<'_>, id: &str, lease: &Lease) -> Result<(), AuthorityError> {
    let actual: Option<(Option<String>, u64)> = tx
        .query_row(
            "SELECT lease_owner,lease_generation FROM jobs WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| AuthorityError::Storage)?;
    match actual {
        None => Err(AuthorityError::NotFound),
        Some((Some(owner), generation))
            if owner == lease.owner && generation == lease.generation =>
        {
            Ok(())
        }
        _ => Err(AuthorityError::StaleLease),
    }
}

fn verify_current_run(tx: &Transaction<'_>, id: &str, run_id: &str) -> Result<(), AuthorityError> {
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT run_id,state FROM runs WHERE job_id=?1 ORDER BY rowid DESC LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| AuthorityError::Storage)?;
    match current {
        Some((current_run, state))
            if current_run == run_id
                && !matches!(
                    state.as_str(),
                    "succeeded" | "failed" | "aborted" | "interrupted"
                ) =>
        {
            Ok(())
        }
        _ => Err(AuthorityError::InvalidTransition),
    }
}

fn append_for_run(
    tx: &Transaction<'_>,
    id: &str,
    run_id: &str,
    event_id: &str,
    payload: &Value,
) -> Result<JobEvent, AuthorityError> {
    validate_id(event_id)?;
    let existing_run: Option<Option<String>> = tx
        .query_row(
            "SELECT run_id FROM job_events WHERE job_id=?1 AND event_id=?2",
            params![id, event_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| AuthorityError::Storage)?;
    if existing_run.is_some_and(|existing| existing.as_deref() != Some(run_id)) {
        return Err(AuthorityError::EventConflict);
    }
    let event = append(tx, id, event_id, payload)?;
    tx.execute(
        "UPDATE job_events SET run_id=?3 WHERE job_id=?1 AND event_id=?2",
        params![id, event_id, run_id],
    )
    .map_err(|_| AuthorityError::Storage)?;
    Ok(event)
}

fn is_unique_constraint(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(code, _)
            if matches!(
                code.extended_code,
                rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
                    | rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
            )
    )
}
fn map_insert(error: rusqlite::Error) -> AuthorityError {
    if is_unique_constraint(&error) {
        AuthorityError::AlreadyExists
    } else {
        AuthorityError::Storage
    }
}
fn exists(connection: &Connection, id: &str) -> Result<bool, AuthorityError> {
    connection
        .query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1)", [id], |r| {
            r.get(0)
        })
        .map_err(|_| AuthorityError::Storage)
}
fn state(tx: &Transaction<'_>, id: &str) -> Result<JobState, AuthorityError> {
    tx.query_row("SELECT state FROM jobs WHERE id=?1", [id], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(|_| AuthorityError::Storage)?
    .ok_or(AuthorityError::NotFound)
    .and_then(|s| JobState::parse(&s))
}
fn append(
    tx: &Transaction<'_>,
    id: &str,
    event_id: &str,
    payload: &Value,
) -> Result<JobEvent, AuthorityError> {
    let encoded = serde_json::to_string(payload).map_err(|_| AuthorityError::Storage)?;
    if let Some(existing) = tx
        .query_row(
            "SELECT sequence,payload FROM job_events WHERE job_id=?1 AND event_id=?2",
            params![id, event_id],
            |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|_| AuthorityError::Storage)?
    {
        let value = serde_json::from_str(&existing.1).map_err(|_| AuthorityError::Storage)?;
        return if value == *payload {
            Ok(JobEvent {
                sequence: existing.0,
                event_id: event_id.to_owned(),
                payload: value,
            })
        } else {
            Err(AuthorityError::EventConflict)
        };
    }
    let sequence: u64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM job_events WHERE job_id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|_| AuthorityError::Storage)?;
    match tx.execute(
        "INSERT INTO job_events (job_id,sequence,event_id,payload) VALUES (?1,?2,?3,?4)",
        params![id, sequence, event_id, encoded],
    ) {
        Ok(_) => {}
        Err(error) if is_unique_constraint(&error) => {
            let existing = tx
                .query_row(
                    "SELECT sequence,payload FROM job_events WHERE job_id=?1 AND event_id=?2",
                    params![id, event_id],
                    |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|_| AuthorityError::Storage)?
                .ok_or(AuthorityError::Storage)?;
            let value = serde_json::from_str(&existing.1).map_err(|_| AuthorityError::Storage)?;
            return if value == *payload {
                Ok(JobEvent {
                    sequence: existing.0,
                    event_id: event_id.to_owned(),
                    payload: value,
                })
            } else {
                Err(AuthorityError::EventConflict)
            };
        }
        Err(_) => return Err(AuthorityError::Storage),
    }
    Ok(JobEvent {
        sequence,
        event_id: event_id.to_owned(),
        payload: payload.clone(),
    })
}
fn event_from_row(row: &rusqlite::Row<'_>) -> Result<JobEvent, rusqlite::Error> {
    Ok(JobEvent {
        sequence: row.get(0)?,
        event_id: row.get(1)?,
        payload: serde_json::from_str::<Value>(&row.get::<_, String>(2)?).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
        })?,
    })
}
fn snapshot_connection(connection: &Connection, id: &str) -> Result<JobSnapshot, AuthorityError> {
    connection.query_row("SELECT j.id,j.provider,j.state,j.lease_owner,j.lease_generation,j.worktree_id,j.branch,j.base_commit,j.repository_root,COALESCE(MAX(e.sequence),0),(SELECT run_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT app_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT provider_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT dispatched_at FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),j.created_at,j.prompt FROM jobs j LEFT JOIN job_events e ON e.job_id=j.id WHERE j.id=?1 GROUP BY j.id", [id], snapshot_from_row).optional().map_err(|_| AuthorityError::Storage)?.ok_or(AuthorityError::NotFound)
}
fn snapshot_tx(tx: &Transaction<'_>, id: &str) -> Result<JobSnapshot, AuthorityError> {
    tx.query_row("SELECT j.id,j.provider,j.state,j.lease_owner,j.lease_generation,j.worktree_id,j.branch,j.base_commit,j.repository_root,COALESCE(MAX(e.sequence),0),(SELECT run_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT app_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT provider_session_id FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),(SELECT dispatched_at FROM runs WHERE job_id=j.id ORDER BY rowid DESC LIMIT 1),j.created_at,j.prompt FROM jobs j LEFT JOIN job_events e ON e.job_id=j.id WHERE j.id=?1 GROUP BY j.id", [id], snapshot_from_row).optional().map_err(|_| AuthorityError::Storage)?.ok_or(AuthorityError::NotFound)
}
fn snapshot_from_row(row: &rusqlite::Row<'_>) -> Result<JobSnapshot, rusqlite::Error> {
    let state: String = row.get(2)?;
    let owner: Option<String> = row.get(3)?;
    let run_id: Option<String> = row.get(10)?;
    let dispatched_at: Option<String> = row.get(13)?;
    Ok(JobSnapshot {
        job_id: row.get(0)?,
        provider: row.get(1)?,
        state: JobState::parse(&state).map_err(|_| rusqlite::Error::InvalidQuery)?,
        lease: owner.map(|owner| Lease {
            owner,
            generation: row.get(4).unwrap_or(0),
        }),
        worktree_id: row.get(5)?,
        branch: row.get(6)?,
        base_commit: row.get(7)?,
        repository_root: row.get(8)?,
        created_at: row.get(14)?,
        prompt: row.get(15)?,
        last_sequence: row.get(9)?,
        current_run: run_id.clone().map(|run_id| CurrentRun {
            run_id,
            app_session_id: row.get(11).unwrap_or(None),
            provider_session_id: row.get(12).unwrap_or(None),
        }),
        dispatch_checkpoint: dispatched_at.map(|_| DispatchCheckpoint {
            run_id: run_id.unwrap_or_default(),
        }),
    })
}

fn validate_database_path(path: &Path) -> Result<PathBuf, AuthorityError> {
    if !path.is_absolute() {
        return Err(AuthorityError::Storage);
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AuthorityError::Storage);
        }
    }
    let file_name = path.file_name().ok_or(AuthorityError::Storage)?;
    let parent = path.parent().ok_or(AuthorityError::Storage)?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|_| AuthorityError::Storage)?;
    if !canonical_parent.is_dir() {
        return Err(AuthorityError::Storage);
    }
    Ok(canonical_parent.join(file_name))
}

#[derive(Deserialize)]
struct LegacyJob {
    state: JobState,
    lease: Option<Lease>,
    next_lease_generation: u64,
    events: Vec<JobEvent>,
    #[serde(default, rename = "event_sequences")]
    _event_sequences: HashMap<String, usize>,
}
#[derive(Deserialize, Default)]
struct LegacyAuthority {
    jobs: HashMap<String, LegacyJob>,
}
fn create_normalized(tx: &Transaction<'_>) -> Result<(), AuthorityError> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, lease_owner TEXT NULL, lease_generation INTEGER NOT NULL DEFAULT 0, next_lease_generation INTEGER NOT NULL DEFAULT 1, worktree_id TEXT NULL, branch TEXT NULL, base_commit TEXT NULL, repository_root TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, app_session_id TEXT NULL, provider_session_id TEXT NULL, state TEXT NOT NULL DEFAULT 'queued', outcome TEXT NULL, dispatched_at TEXT NULL); CREATE TABLE IF NOT EXISTS job_events (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, run_id TEXT NULL REFERENCES runs(run_id), UNIQUE(job_id,sequence), UNIQUE(job_id,event_id)); CREATE INDEX IF NOT EXISTS job_events_job_sequence ON job_events(job_id,sequence); CREATE TABLE IF NOT EXISTS session_job_bindings (provider TEXT NOT NULL, app_session_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), provider_session_id TEXT NULL, bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, released_at TEXT NULL, UNIQUE(job_id)); CREATE UNIQUE INDEX IF NOT EXISTS active_session_job_bindings ON session_job_bindings(provider,app_session_id) WHERE released_at IS NULL;").map_err(|_| AuthorityError::Storage)
}
fn migrate(connection: &mut Connection) -> Result<(), AuthorityError> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| AuthorityError::Storage)?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);").map_err(|_| AuthorityError::Storage)?;
    let mut version: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .map_err(|_| AuthorityError::Storage)?;
    if version > 7 {
        return Err(AuthorityError::Storage);
    }
    if version == 0 {
        create_normalized(&tx)?;
        tx.execute("INSERT INTO schema_migrations(version) VALUES(5)", [])
            .map_err(|_| AuthorityError::Storage)?;
        version = 5;
    }
    if version == 1 {
        let blob: String = tx
            .query_row("SELECT state_json FROM job_authority WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| AuthorityError::Storage)?
            .ok_or(AuthorityError::Storage)?;
        let legacy: LegacyAuthority =
            serde_json::from_str(&blob).map_err(|_| AuthorityError::Storage)?;
        validate_legacy(&legacy)?;
        create_normalized(&tx)?;
        for (id, job) in legacy.jobs {
            tx.execute("INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,'gjc',?2,?3,?4,?5)", params![id,job.state.as_str(),job.lease.as_ref().map(|l| &l.owner),job.lease.as_ref().map_or(0,|l|l.generation),job.next_lease_generation]).map_err(|_| AuthorityError::Storage)?;
            for event in job.events {
                tx.execute(
                    "INSERT INTO job_events(job_id,sequence,event_id,payload) VALUES(?1,?2,?3,?4)",
                    params![
                        id,
                        event.sequence,
                        event.event_id,
                        serde_json::to_string(&event.payload)
                            .map_err(|_| AuthorityError::Storage)?
                    ],
                )
                .map_err(|_| AuthorityError::Storage)?;
            }
        }
        tx.execute_batch("DROP TABLE IF EXISTS job_authority;")
            .map_err(|_| AuthorityError::Storage)?;
        tx.execute("INSERT INTO schema_migrations(version) VALUES(5)", [])
            .map_err(|_| AuthorityError::Storage)?;
        version = 5;
    }
    if version == 2 {
        tx.execute("INSERT INTO schema_migrations(version) VALUES(3)", [])
            .map_err(|_| AuthorityError::Storage)?;
        version = 3;
    }
    if version == 3 {
        tx.execute("ALTER TABLE runs ADD COLUMN dispatched_at TEXT NULL", [])
            .map_err(|_| AuthorityError::Storage)?;
        tx.execute("INSERT INTO schema_migrations(version) VALUES(4)", [])
            .map_err(|_| AuthorityError::Storage)?;
        version = 4;
    }
    if version == 4 {
        tx.execute_batch("ALTER TABLE jobs ADD COLUMN base_commit TEXT NULL; ALTER TABLE jobs ADD COLUMN repository_root TEXT NULL; ALTER TABLE runs ADD COLUMN state TEXT NOT NULL DEFAULT 'queued'; ALTER TABLE runs ADD COLUMN outcome TEXT NULL; ALTER TABLE job_events ADD COLUMN run_id TEXT NULL REFERENCES runs(run_id); CREATE TABLE session_job_bindings (provider TEXT NOT NULL, app_session_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), provider_session_id TEXT NULL, bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, released_at TEXT NULL, UNIQUE(job_id)); CREATE UNIQUE INDEX active_session_job_bindings ON session_job_bindings(provider,app_session_id) WHERE released_at IS NULL;").map_err(|_| AuthorityError::Storage)?;
        tx.execute("INSERT INTO schema_migrations(version) VALUES(5)", [])
            .map_err(|_| AuthorityError::Storage)?;
        version = 5;
    }
    if version == 5 {
        tx.execute_batch("ALTER TABLE jobs ADD COLUMN prompt TEXT NULL; INSERT INTO schema_migrations(version) VALUES(6);")
            .map_err(|_| AuthorityError::Storage)?;
        version = 6;
    }
    if version == 6 {
        tx.execute_batch("ALTER TABLE jobs ADD COLUMN archived_at TEXT NULL; INSERT INTO schema_migrations(version) VALUES(7);")
            .map_err(|_| AuthorityError::Storage)?;
    }
    tx.commit().map_err(|_| AuthorityError::Storage)
}
fn validate_legacy(legacy: &LegacyAuthority) -> Result<(), AuthorityError> {
    for (id, job) in &legacy.jobs {
        validate_id(id).map_err(|_| AuthorityError::Storage)?;
        if job.next_lease_generation == 0 || job.state.is_terminal() && job.lease.is_some() {
            return Err(AuthorityError::Storage);
        }
        if let Some(lease) = &job.lease {
            validate_id(&lease.owner).map_err(|_| AuthorityError::Storage)?;
            if lease.generation == 0 || job.next_lease_generation <= lease.generation {
                return Err(AuthorityError::Storage);
            }
        }
        let mut event_ids = HashSet::new();
        for (index, event) in job.events.iter().enumerate() {
            validate_id(&event.event_id).map_err(|_| AuthorityError::Storage)?;
            if event.sequence != (index + 1) as u64 || !event_ids.insert(&event.event_id) {
                return Err(AuthorityError::Storage);
            }
        }
    }
    Ok(())
}
fn validate_id(value: &str) -> Result<(), AuthorityError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        Err(AuthorityError::InvalidIdentifier)
    } else {
        Ok(())
    }
}
fn validate_prompt(value: &str) -> Result<&str, AuthorityError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 4096 {
        Err(AuthorityError::InvalidIdentifier)
    } else {
        Ok(value)
    }
}
fn validate_worktree_id(value: &str) -> Result<(), AuthorityError> {
    if value.is_empty()
        || value.len() > 4096
        || !std::path::Path::new(value).is_absolute()
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        Err(AuthorityError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

// A managed branch is exactly `job/<slug>`; the slug is lowercase ASCII
// alphanumerics and hyphens. The authority keeps it otherwise opaque — git.rs
// owns ref naming — but rejects path traversal, leading hyphens, and injection.
fn validate_branch(value: &str) -> Result<(), AuthorityError> {
    let slug = match value.strip_prefix("job/") {
        Some(slug) => slug,
        None => return Err(AuthorityError::InvalidIdentifier),
    };
    let bytes = slug.as_bytes();
    if slug.is_empty()
        || slug.len() > 128
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return Err(AuthorityError::InvalidIdentifier);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u8,
    id: String,
    method: String,
    job_id: Option<String>,
    owner: Option<String>,
    lease: Option<Lease>,
    state: Option<JobState>,
    terminal_run_state: Option<JobState>,
    event_id: Option<String>,
    payload: Option<Value>,
    after: Option<u64>,
    provider: Option<String>,
    prompt: Option<String>,
    byte_budget: Option<u64>,
    after_cursor: Option<String>,
    limit: Option<u64>,
    archived: Option<ArchiveFilter>,
    cap: Option<u64>,
    worktree_id: Option<String>,
    branch: Option<String>,
    base_commit: Option<String>,
    repository_root: Option<String>,
    run_id: Option<String>,
    app_session_id: Option<String>,
    provider_session_id: Option<String>,
    terminal_event: Option<TerminalEvent>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    protocol_version: u8,
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}
fn replay_response_size(id: &str, replay: &Replay) -> Result<u64, AuthorityError> {
    serde_json::to_vec(&Response {
        protocol_version: 1,
        id,
        ok: true,
        result: Some(serde_json::to_value(replay).map_err(|_| AuthorityError::Storage)?),
        error: None,
    })
    .map(|value| value.len() as u64 + 1)
    .map_err(|_| AuthorityError::Storage)
}
pub fn run<R: BufRead, W: Write>(database: &Path, mut input: R, mut output: W) -> bool {
    let mut authority = match PersistentAuthority::open(database) {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut frame = Vec::new();
    loop {
        frame.clear();
        let read = match Read::by_ref(&mut input)
            .take(MAX_FRAME_BYTES as u64 + 2)
            .read_until(b'\n', &mut frame)
        {
            Ok(v) => v,
            Err(_) => return false,
        };
        if read == 0 {
            return true;
        }
        if frame.len() > MAX_FRAME_BYTES + 1 || !frame.ends_with(b"\n") {
            return false;
        }
        frame.pop();
        let request: Request = match serde_json::from_slice(&frame) {
            Ok(v) => v,
            Err(_) => return false,
        };
        if request.protocol_version != 1 || validate_id(&request.id).is_err() {
            return false;
        }
        let response = match dispatch(&mut authority, &request) {
            Ok(v) => Response {
                protocol_version: 1,
                id: &request.id,
                ok: true,
                result: Some(v),
                error: None,
            },
            Err(e) => Response {
                protocol_version: 1,
                id: &request.id,
                ok: false,
                result: None,
                error: Some(error_code(e)),
            },
        };
        let encoded = match serde_json::to_vec(&response) {
            Ok(encoded) if encoded.len() <= MAX_FRAME_BYTES => encoded,
            _ => match serde_json::to_vec(&Response {
                protocol_version: 1,
                id: &request.id,
                ok: false,
                result: None,
                error: Some(error_code(AuthorityError::Storage)),
            }) {
                Ok(encoded) if encoded.len() <= MAX_FRAME_BYTES => encoded,
                _ => return false,
            },
        };
        if output.write_all(&encoded).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            return false;
        }
    }
}
fn dispatch(
    authority: &mut PersistentAuthority,
    request: &Request,
) -> Result<Value, AuthorityError> {
    let id = || {
        request
            .job_id
            .as_deref()
            .ok_or(AuthorityError::InvalidIdentifier)
    };
    let lease = || request.lease.as_ref().ok_or(AuthorityError::StaleLease);
    let provider = || {
        request
            .provider
            .as_deref()
            .ok_or(AuthorityError::InvalidIdentifier)
    };
    let value = match request.method.as_str() {
        "job.activity" => serde_json::to_value(authority.activity()?),
        "job.get" => serde_json::to_value(authority.snapshot(id()?)?),
        "lease.acquire" => serde_json::to_value(
            authority.acquire(
                id()?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "job.transition" => serde_json::to_value(authority.transition(
            id()?,
            lease()?,
            request.state.ok_or(AuthorityError::InvalidTransition)?,
        )?),
        "event.append" => {
            let event_id = request
                .event_id
                .as_deref()
                .ok_or(AuthorityError::InvalidIdentifier)?;
            let payload = request
                .payload
                .clone()
                .ok_or(AuthorityError::InvalidIdentifier)?;
            serde_json::to_value(match request.run_id.as_deref() {
                Some(run_id) => {
                    authority.append_event_for_run(id()?, lease()?, run_id, event_id, payload)?
                }
                None => authority.append_event(id()?, lease()?, event_id, payload)?,
            })
        }
        "job.appendAdminEvent" => {
            let event_id = request
                .event_id
                .as_deref()
                .ok_or(AuthorityError::InvalidIdentifier)?;
            let payload = request
                .payload
                .clone()
                .ok_or(AuthorityError::InvalidIdentifier)?;
            serde_json::to_value(authority.append_admin_event(id()?, event_id, payload)?)
        }
        "job.finalize" => serde_json::to_value(
            authority.finalize(
                id()?,
                lease()?,
                request
                    .event_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .payload
                    .clone()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.state.ok_or(AuthorityError::InvalidTransition)?,
            )?,
        ),
        "job.cancelAdmission" => serde_json::to_value(
            authority.cancel_admission(
                id()?,
                lease()?,
                request
                    .event_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .payload
                    .clone()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.terminal_event.clone(),
            )?,
        ),
        "event.replay" => serde_json::to_value(
            authority.replay(
                id()?,
                request.after.unwrap_or(0),
                request
                    .byte_budget
                    .unwrap_or(DEFAULT_REPLAY_BUDGET)
                    .min(DEFAULT_REPLAY_BUDGET),
                &request.id,
            )?,
        ),
        "job.list" => serde_json::to_value(
            authority.list_filtered(
                request.state,
                request.provider.as_deref(),
                request.after_cursor.as_deref(),
                request.limit.unwrap_or(50),
                request
                    .byte_budget
                    .unwrap_or(DEFAULT_LIST_BUDGET)
                    .min(DEFAULT_LIST_BUDGET),
                request.archived.unwrap_or(ArchiveFilter::Exclude),
            )?,
        ),
        "job.archive" => serde_json::to_value(authority.archive(id()?)?),
        "job.unarchive" => serde_json::to_value(authority.unarchive(id()?)?),
        "job.readmit" => serde_json::to_value(
            authority.readmit(
                id()?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .app_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.cap.unwrap_or(DEFAULT_CAPACITY),
            )?,
        ),
        "job.prepare" => serde_json::to_value(
            authority.prepare(
                id()?,
                lease()?,
                request
                    .worktree_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .branch
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .base_commit
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .repository_root
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "job.admit" => serde_json::to_value(
            authority.admit(
                id()?,
                lease()?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .app_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "job.markDispatching" => serde_json::to_value(
            authority.mark_dispatching(
                id()?,
                lease()?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "run.bindProviderSession" => serde_json::to_value(
            authority.bind_provider_session(
                id()?,
                lease()?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .provider_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "capacity.reserve" => serde_json::to_value(
            authority.reserve(
                id()?,
                provider()?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.cap.unwrap_or(DEFAULT_CAPACITY),
            )?,
        ),
        "job.reserveStart" => serde_json::to_value(
            authority.reserve_start(
                id()?,
                request
                    .provider
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .app_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.prompt.as_deref(),
                request.cap.unwrap_or(DEFAULT_CAPACITY),
            )?,
        ),
        "job.turnAdmit" => serde_json::to_value(
            authority.turn_admit(
                id()?,
                request
                    .app_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .owner
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request.cap.unwrap_or(DEFAULT_CAPACITY),
            )?,
        ),
        "run.finalize" => serde_json::to_value(
            authority.finalize_run(
                id()?,
                lease()?,
                request
                    .run_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .terminal_run_state
                    .or(request.state)
                    .ok_or(AuthorityError::InvalidTransition)?,
                request
                    .event_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .payload
                    .clone()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "binding.resolve" => serde_json::to_value(
            authority.resolve_binding(
                request
                    .provider
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
                request
                    .app_session_id
                    .as_deref()
                    .ok_or(AuthorityError::InvalidIdentifier)?,
            )?,
        ),
        "binding.release" => serde_json::to_value({
            authority.release_binding(id()?)?;
            Value::Null
        }),
        "job.interruptForShutdown" if request.job_id.is_none() => {
            serde_json::to_value(authority.interrupt_for_shutdown()?)
        }
        "job.reconcile" if request.job_id.is_none() => serde_json::to_value(authority.reconcile()?),
        _ => return Err(AuthorityError::InvalidIdentifier),
    };
    value.map_err(|_| AuthorityError::Storage)
}
fn error_code(error: AuthorityError) -> &'static str {
    match error {
        AuthorityError::InvalidIdentifier => "invalid_request",
        AuthorityError::AlreadyExists => "already_exists",
        AuthorityError::NotFound => "not_found",
        AuthorityError::LeaseHeld => "lease_held",
        AuthorityError::StaleLease => "stale_lease",
        AuthorityError::InvalidTransition => "invalid_transition",
        AuthorityError::TerminalJob => "terminal_job",
        AuthorityError::EventConflict => "event_conflict",
        AuthorityError::CapacityExhausted => "capacity_exhausted",
        AuthorityError::WorktreeConflict => "worktree_conflict",
        AuthorityError::AuthorityHeld => "authority_held",
        AuthorityError::Storage => "storage_failure",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_is_complete_read_only_and_includes_archived_jobs_and_nonterminal_runs() {
        let (directory, database) = db();
        let authority = PersistentAuthority::open(&database).unwrap();
        for index in 0..151 {
            authority.connection.execute(
                "INSERT INTO jobs(id,provider,state,archived_at) VALUES(?1,'gjc','queued','2026-01-01')",
                [format!("archived-{index}")],
            ).unwrap();
        }
        authority
            .connection
            .execute(
                "INSERT INTO jobs(id,provider,state) VALUES('ready','gjc','ready')",
                [],
            )
            .unwrap();
        authority
            .connection
            .execute(
                "INSERT INTO runs(run_id,job_id,state) VALUES('unfinished','ready','running')",
                [],
            )
            .unwrap();
        authority
            .connection
            .execute(
                "INSERT INTO jobs(id,provider,state) VALUES('unknown','gjc','not-a-state')",
                [],
            )
            .unwrap();
        let before = authority.connection.total_changes();
        let observed = authority.activity().unwrap();
        assert_eq!(
            observed,
            JobActivity {
                schema_version: 1,
                reserved: 0,
                queued: 151,
                running: 1,
                aborting: 0,
                unknown: 1
            }
        );
        assert_eq!(authority.activity().unwrap(), observed);
        assert_eq!(
            authority.connection.total_changes(),
            before,
            "observation must not reconcile or mutate"
        );
        drop(authority);
        std::fs::remove_dir_all(directory).unwrap();
    }
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Barrier};
    fn db() -> (std::path::PathBuf, std::path::PathBuf) {
        // A process-unique counter avoids collisions when parallel tests read
        // the same coarse SystemTime nanosecond value (observed on macOS).
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "gajae-jobs-{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&d).unwrap();
        (d.clone(), d.join("jobs.sqlite"))
    }
    #[test]
    fn append_idempotency_and_constraints() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("j", "gjc", "o", 4).unwrap();
        let l = a.snapshot("j").unwrap().lease.unwrap();
        assert_eq!(a.append_event("j", &l, "e", json!(1)).unwrap().sequence, 1);
        assert_eq!(a.append_event("j", &l, "e", json!(1)).unwrap().sequence, 1);
        assert_eq!(
            a.append_event("j", &l, "e", json!(2)),
            Err(AuthorityError::EventConflict)
        );
        assert!(
            a.connection
                .execute("INSERT INTO job_events VALUES('j',1,'x','{}')", [])
                .is_err()
        );
        assert!(
            a.connection
                .execute("INSERT INTO job_events VALUES('j',2,'e','{}')", [])
                .is_err()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn admin_events_append_after_a_run_and_reject_active_jobs() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("job", "gjc", "worker", 4).unwrap();
        let lease = a.snapshot("job").unwrap().lease.unwrap();
        a.prepare(
            "job",
            &lease,
            "/tmp/job-worktree",
            "job/job",
            "base",
            "/tmp/repository",
        )
        .unwrap();
        a.admit("job", &lease, "run-1", "session").unwrap();
        a.transition("job", &lease, JobState::Running).unwrap();
        assert_eq!(
            a.append_admin_event("job", "publish.started", json!({})),
            Err(AuthorityError::InvalidTransition)
        );
        let ready = a
            .finalize_run(
                "job",
                &lease,
                "run-1",
                JobState::Succeeded,
                "run-1.complete",
                json!({}),
            )
            .unwrap();
        assert_eq!(ready.state, JobState::Ready);
        let event = a
            .append_admin_event("job", "publish.started", json!({"branch":"job/job"}))
            .unwrap();
        assert_eq!(event.sequence, 2);
        assert_eq!(
            a.append_admin_event("job", "publish.started", json!({"branch":"job/job"}))
                .unwrap(),
            event
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn terminal_transitions_require_finalize() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        for (id, terminal) in [
            ("succeeded", JobState::Succeeded),
            ("failed", JobState::Failed),
            ("aborted", JobState::Aborted),
        ] {
            a.reserve(id, "gjc", "o", 4).unwrap();
            let lease = a.snapshot(id).unwrap().lease.unwrap();
            assert_eq!(
                a.transition(id, &lease, terminal),
                Err(AuthorityError::InvalidTransition)
            );
            assert_eq!(a.snapshot(id).unwrap().last_sequence, 0);
        }
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn finalize_is_atomic() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();

        a.reserve("ok", "gjc", "o", 4).unwrap();
        let lease = a.snapshot("ok").unwrap().lease.unwrap();
        a.transition("ok", &lease, JobState::Queued).unwrap();
        a.transition("ok", &lease, JobState::Running).unwrap();
        let snapshot = a
            .finalize("ok", &lease, "done", json!(1), JobState::Succeeded)
            .unwrap();
        assert_eq!(snapshot.state, JobState::Succeeded);
        assert_eq!(snapshot.lease, None);
        assert_eq!(a.replay("ok", 0, 999, "test").unwrap().events.len(), 1);

        a.reserve("rollback", "gjc", "o", 4).unwrap();
        let lease = a.snapshot("rollback").unwrap().lease.unwrap();
        a.transition("rollback", &lease, JobState::Queued).unwrap();
        a.transition("rollback", &lease, JobState::Running).unwrap();
        a.connection
            .execute_batch("CREATE TRIGGER fail_finalize BEFORE UPDATE OF state ON jobs WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT, 'injected'); END;")
            .unwrap();
        assert_eq!(
            a.finalize("rollback", &lease, "done", json!(1), JobState::Succeeded),
            Err(AuthorityError::Storage)
        );
        assert_eq!(a.snapshot("rollback").unwrap().state, JobState::Running);
        assert!(
            a.replay("rollback", 0, 999, "test")
                .unwrap()
                .events
                .is_empty()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn aborting_run_can_finalize_succeeded_only_with_current_lease() {
        let (d, p) = db();
        let mut authority = PersistentAuthority::open(&p).unwrap();
        authority.reserve("j", "gjc", "worker", 4).unwrap();
        let lease = authority.snapshot("j").unwrap().lease.unwrap();
        authority.transition("j", &lease, JobState::Queued).unwrap();
        authority
            .transition("j", &lease, JobState::Running)
            .unwrap();
        authority
            .transition("j", &lease, JobState::Aborting)
            .unwrap();

        let stale_lease = Lease {
            owner: lease.owner.clone(),
            generation: lease.generation + 1,
        };
        assert_eq!(
            authority.finalize(
                "j",
                &stale_lease,
                "stale-success",
                json!(null),
                JobState::Succeeded
            ),
            Err(AuthorityError::StaleLease)
        );
        assert_eq!(authority.snapshot("j").unwrap().state, JobState::Aborting);

        let snapshot = authority
            .finalize("j", &lease, "success", json!(null), JobState::Succeeded)
            .unwrap();
        assert_eq!(snapshot.state, JobState::Succeeded);
        assert_eq!(snapshot.lease, None);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn interruption_revokes_lease_and_readmit_fences_old_generation() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("j", "gjc", "worker-1", 4).unwrap();
        let old_lease = a.snapshot("j").unwrap().lease.unwrap();
        a.transition("j", &old_lease, JobState::Queued).unwrap();
        a.transition("j", &old_lease, JobState::Running).unwrap();

        let interrupted = a
            .transition("j", &old_lease, JobState::Interrupted)
            .unwrap();
        assert_eq!(interrupted.lease, None);

        assert_eq!(
            a.acquire("j", "worker-2"),
            Err(AuthorityError::InvalidTransition)
        );
        let readmitted = a.readmit("j", "worker-2", "r2", "session2", 4).unwrap();
        let new_lease = readmitted.lease.unwrap();
        assert_eq!(readmitted.state, JobState::Queued);
        assert_eq!(new_lease.owner, "worker-2");
        assert_eq!(new_lease.generation, old_lease.generation + 1);
        assert_eq!(
            a.append_event("j", &old_lease, "stale", json!(1)),
            Err(AuthorityError::StaleLease)
        );
        assert_eq!(
            a.finalize("j", &old_lease, "stale-final", json!(1), JobState::Aborted),
            Err(AuthorityError::StaleLease)
        );
        assert_eq!(
            a.transition("j", &old_lease, JobState::Running),
            Err(AuthorityError::StaleLease)
        );
        assert_eq!(a.snapshot("j").unwrap().lease, Some(new_lease));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn replay_budget_and_cursor_progress() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("j", "gjc", "o", 4).unwrap();
        let l = a.snapshot("j").unwrap().lease.unwrap();
        a.append_event("j", &l, "a", json!("x".repeat(100)))
            .unwrap();
        a.append_event("j", &l, "b", json!(2)).unwrap();
        let r = a.replay("j", 0, 1, "test").unwrap();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.next_cursor, Some(1));
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn list_budget_bounds_frames_and_cursor_reaches_all_jobs() {
        let (d, p) = db();
        let mut authority = PersistentAuthority::open(&p).unwrap();
        let prompt = "🦀".repeat(4096);
        for number in 0..64 {
            authority
                .reserve_start(
                    &format!("job-{number:03}"),
                    "p",
                    &format!("app-{number:03}"),
                    "owner",
                    Some(&prompt),
                    64,
                )
                .unwrap();
        }
        drop(authority);

        let mut after = None;
        let mut job_ids = Vec::new();
        loop {
            let request = json!({
                "protocolVersion": 1,
                "id": "list",
                "method": "job.list",
                "afterCursor": after.as_deref(),
                "limit": 64,
            });
            let mut output = Vec::new();
            assert!(run(
                &p,
                std::io::Cursor::new(format!("{request}\n").into_bytes()),
                &mut output,
            ));
            assert_eq!(output.last(), Some(&b'\n'));
            let frame = &output[..output.len() - 1];
            assert!(frame.len() <= MAX_FRAME_BYTES);
            let response: Value = serde_json::from_slice(frame).unwrap();
            let items = response["result"]["items"].as_array().unwrap();
            assert!(!items.is_empty());
            job_ids.extend(
                items
                    .iter()
                    .map(|item| item["jobId"].as_str().unwrap().to_owned()),
            );
            after = match response["result"]["nextCursor"].as_str() {
                Some(cursor) => {
                    assert_eq!(
                        Some(cursor),
                        items.last().and_then(|item| item["jobId"].as_str())
                    );
                    Some(cursor.to_owned())
                }
                None => break,
            };
        }
        assert_eq!(
            job_ids,
            (0..64)
                .map(|number| format!("job-{number:03}"))
                .collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn list_capacity_and_reopen_reconcile() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        for n in 0..4 {
            a.reserve(&format!("j{n}"), "p", "o", 4).unwrap();
        }
        assert_eq!(
            a.reserve("j4", "p", "o", 4),
            Err(AuthorityError::CapacityExhausted)
        );
        let l = a.snapshot("j0").unwrap().lease.unwrap();
        assert_eq!(
            a.transition("j0", &l, JobState::Aborted),
            Err(AuthorityError::InvalidTransition)
        );
        a.finalize("j0", &l, "aborted", json!(null), JobState::Aborted)
            .unwrap();
        a.reserve("j4", "p", "o", 4).unwrap();
        assert_eq!(
            a.list(
                Some(JobState::Reserved),
                Some("p"),
                Some("j0"),
                10,
                DEFAULT_LIST_BUDGET,
            )
            .unwrap()
            .items
            .len(),
            4
        );
        a.reserve("run", "p", "o", 64).unwrap();
        let l = a.snapshot("run").unwrap().lease.unwrap();
        a.transition("run", &l, JobState::Queued).unwrap();
        a.transition("run", &l, JobState::Running).unwrap();
        assert!(matches!(
            PersistentAuthority::open(&p),
            Err(AuthorityError::AuthorityHeld)
        ));
        drop(a);
        let mut a = PersistentAuthority::open(&p).unwrap();
        let snapshot = a.snapshot("run").unwrap();
        assert_eq!(snapshot.state, JobState::Interrupted);
        assert_eq!(snapshot.lease, None);
        assert_eq!(
            a.append_event("run", &l, "stale", json!(1)),
            Err(AuthorityError::StaleLease)
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn immediate_reserve_serializes_competing_connections() {
        let (d, p) = db();
        let mut authority = PersistentAuthority::open(&p).unwrap();
        for n in 0..3 {
            authority.reserve(&format!("j{n}"), "p", "o", 4).unwrap();
        }

        let mut first = Connection::open(&p).unwrap();
        let mut second = Connection::open(&p).unwrap();
        first
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        second
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let first_barrier = Arc::clone(&barrier);
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            let tx = first
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let count: u64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM jobs WHERE state IN ('reserved','queued','running','aborting')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let state = if count < 4 { "reserved" } else { "interrupted" };
            tx.execute(
                "INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,'p',?2,CASE WHEN ?2='reserved' THEN 'o' END,CASE WHEN ?2='reserved' THEN 1 ELSE 0 END,CASE WHEN ?2='reserved' THEN 2 ELSE 1 END)",
                params!["j3", state],
            )
            .unwrap();
            tx.commit().unwrap();
            state.to_owned()
        });
        let second_barrier = Arc::clone(&barrier);
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            let tx = second
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let count: u64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM jobs WHERE state IN ('reserved','queued','running','aborting')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let state = if count < 4 { "reserved" } else { "interrupted" };
            tx.execute(
                "INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,'p',?2,CASE WHEN ?2='reserved' THEN 'o' END,CASE WHEN ?2='reserved' THEN 1 ELSE 0 END,CASE WHEN ?2='reserved' THEN 2 ELSE 1 END)",
                params!["j4", state],
            )
            .unwrap();
            tx.commit().unwrap();
            state.to_owned()
        });
        let states = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(
            states
                .iter()
                .filter(|state| state.as_str() == "reserved")
                .count(),
            1
        );
        assert_eq!(
            states
                .iter()
                .filter(|state| state.as_str() == "interrupted")
                .count(),
            1
        );
        assert_eq!(
            authority
                .list(
                    Some(JobState::Reserved),
                    None,
                    None,
                    10,
                    DEFAULT_LIST_BUDGET,
                )
                .unwrap()
                .items
                .len(),
            4
        );
        assert_eq!(
            authority
                .list(None, None, None, 10, DEFAULT_LIST_BUDGET)
                .unwrap()
                .items
                .len(),
            5
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn reserve_start_prompt_round_trips_through_get_and_list() {
        let (d, p) = db();
        let input = concat!(
            r#"{"protocolVersion":1,"id":"reserve","method":"job.reserveStart","jobId":"job","provider":"p","appSessionId":"app","owner":"owner","cap":1,"prompt":"  draft  "}"#,
            "\n",
            r#"{"protocolVersion":1,"id":"get","method":"job.get","jobId":"job"}"#,
            "\n",
            r#"{"protocolVersion":1,"id":"list","method":"job.list"}"#,
            "\n"
        );
        let mut output = Vec::new();
        assert!(run(&p, std::io::Cursor::new(input.as_bytes()), &mut output,));
        let responses: Vec<Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[1]["result"]["prompt"], json!("draft"));
        assert!(
            !responses[1]["result"]["createdAt"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert_eq!(responses[2]["result"]["items"][0]["prompt"], json!("draft"));
        assert!(
            !responses[2]["result"]["items"][0]["createdAt"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn list_truncates_prompts_but_get_retains_them() {
        let (d, p) = db();
        let prompt = "🦀".repeat(257);
        let input = format!(
            "{}\n{}\n{}\n",
            json!({
                "protocolVersion": 1,
                "id": "reserve",
                "method": "job.reserveStart",
                "jobId": "job",
                "provider": "p",
                "appSessionId": "app",
                "owner": "owner",
                "cap": 1,
                "prompt": prompt,
            }),
            json!({
                "protocolVersion": 1,
                "id": "get",
                "method": "job.get",
                "jobId": "job",
            }),
            json!({
                "protocolVersion": 1,
                "id": "list",
                "method": "job.list",
            }),
        );
        let mut output = Vec::new();
        assert!(run(
            &p,
            std::io::Cursor::new(input.into_bytes()),
            &mut output
        ));
        let responses: Vec<Value> = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();

        assert_eq!(responses[1]["result"]["prompt"], json!(prompt));
        assert_eq!(
            responses[2]["result"]["items"][0]["prompt"],
            json!("🦀".repeat(256))
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn reserve_start_rejects_prompt_over_4096_chars() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let maximum = "x".repeat(4096);
        assert_eq!(
            a.reserve_start("maximum", "p", "app", "owner", Some(&maximum), 1)
                .unwrap()
                .prompt
                .as_deref(),
            Some(maximum.as_str())
        );
        let too_long = "x".repeat(4097);
        assert_eq!(
            a.reserve_start("too-long", "p", "app", "owner", Some(&too_long), 1),
            Err(AuthorityError::InvalidIdentifier)
        );
        assert_eq!(
            a.reserve_start("empty", "p", "app", "owner", Some("   "), 1),
            Err(AuthorityError::InvalidIdentifier)
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn reserve_start_without_prompt_round_trips_null() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let reserved = a
            .reserve_start("job", "p", "app", "owner", None, 1)
            .unwrap();
        assert_eq!(reserved.prompt, None);
        let snapshot = a.snapshot("job").unwrap();
        assert_eq!(snapshot.prompt, None);
        assert_eq!(
            serde_json::to_value(snapshot).unwrap()["prompt"],
            json!(null)
        );
        assert_eq!(
            a.list(None, None, None, 1, DEFAULT_LIST_BUDGET)
                .unwrap()
                .items[0]
                .prompt,
            None
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn archive_commands_filter_without_changing_snapshot_shape() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("active", "p", "owner", 4).unwrap();
        assert_eq!(a.archive("active"), Err(AuthorityError::InvalidTransition));
        let active_lease = a.snapshot("active").unwrap().lease.unwrap();
        a.transition("active", &active_lease, JobState::Queued)
            .unwrap();
        assert_eq!(a.archive("active"), Err(AuthorityError::InvalidTransition));
        a.transition("active", &active_lease, JobState::Running)
            .unwrap();
        assert_eq!(a.archive("active"), Err(AuthorityError::InvalidTransition));
        a.transition("active", &active_lease, JobState::Aborting)
            .unwrap();
        assert_eq!(a.archive("active"), Err(AuthorityError::InvalidTransition));

        let ready = a.reserve("ready", "p", "owner", 4).unwrap();
        let lease = ready.lease.unwrap();
        a.transition("ready", &lease, JobState::Queued).unwrap();
        a.transition("ready", &lease, JobState::Running).unwrap();
        a.finalize("ready", &lease, "done", json!(null), JobState::Succeeded)
            .unwrap();
        let archived = a.archive("ready").unwrap();
        assert_eq!(archived.state, JobState::Succeeded);
        assert!(
            serde_json::to_value(&archived)
                .unwrap()
                .get("archivedAt")
                .is_none()
        );
        let archived_at: Option<String> = a
            .connection
            .query_row("SELECT archived_at FROM jobs WHERE id='ready'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(archived_at.is_some());
        a.archive("ready").unwrap();
        let archived_at_after_first_archive = archived_at.clone();

        let archived_at_after_second_archive: Option<String> = a
            .connection
            .query_row("SELECT archived_at FROM jobs WHERE id='ready'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            archived_at_after_second_archive,
            archived_at_after_first_archive
        );
        assert_eq!(
            a.list(None, None, None, 10, DEFAULT_LIST_BUDGET)
                .unwrap()
                .items
                .iter()
                .map(|item| item.job_id.as_str())
                .collect::<Vec<_>>(),
            vec!["active"]
        );
        assert_eq!(
            a.list_filtered(
                None,
                None,
                None,
                10,
                DEFAULT_LIST_BUDGET,
                ArchiveFilter::Only,
            )
            .unwrap()
            .items
            .iter()
            .map(|item| item.job_id.as_str())
            .collect::<Vec<_>>(),
            vec!["ready"]
        );
        assert_eq!(
            a.list_filtered(
                None,
                None,
                None,
                10,
                DEFAULT_LIST_BUDGET,
                ArchiveFilter::Include,
            )
            .unwrap()
            .items
            .len(),
            2
        );
        a.unarchive("ready").unwrap();
        a.unarchive("ready").unwrap();
        let archived_at: Option<String> = a
            .connection
            .query_row("SELECT archived_at FROM jobs WHERE id='ready'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(archived_at, None);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn migrates_v5_and_v6_to_v7_with_nullable_archive_column() {
        for version in [5, 6] {
            let (d, p) = db();
            let mut c = Connection::open(&p).unwrap();
            let tx = c.transaction().unwrap();
            create_normalized(&tx).unwrap();
            if version == 6 {
                tx.execute("ALTER TABLE jobs ADD COLUMN prompt TEXT NULL", [])
                    .unwrap();
            }
            tx.execute_batch(&format!(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES({version});"
            ))
            .unwrap();
            tx.execute(
                "INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,?2,?3,?4,1,2)",
                params!["legacy", "p", "reserved", "owner"],
            )
            .unwrap();
            tx.commit().unwrap();
            drop(c);

            let a = PersistentAuthority::open(&p).unwrap();
            assert_eq!(
                a.connection
                    .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                7
            );
            let archived_at: Option<String> = a
                .connection
                .query_row("SELECT archived_at FROM jobs WHERE id='legacy'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(archived_at, None);
            assert_eq!(
                a.list(None, None, None, 1, DEFAULT_LIST_BUDGET)
                    .unwrap()
                    .items
                    .len(),
                1
            );
            drop(a);
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[test]
    fn failed_v7_migration_rolls_back_archive_column() {
        let (d, p) = db();
        let mut c = Connection::open(&p).unwrap();
        let tx = c.transaction().unwrap();
        create_normalized(&tx).unwrap();
        tx.execute("ALTER TABLE jobs ADD COLUMN prompt TEXT NULL", [])
            .unwrap();
        tx.execute_batch("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(6); CREATE TRIGGER fail_v7 BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        tx.commit().unwrap();
        drop(c);

        assert!(matches!(
            PersistentAuthority::open(&p),
            Err(AuthorityError::Storage)
        ));
        let c = Connection::open(&p).unwrap();
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            6
        );
        assert!(
            c.query_row("SELECT archived_at FROM jobs LIMIT 1", [], |_| Ok(()))
                .is_err()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn migrates_v1_blob_once() {
        let (d, p) = db();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(1); CREATE TABLE job_authority(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL);").unwrap();
        let blob=json!({"jobs":{"old":{"state":"queued","lease":null,"next_lease_generation":1,"events":[{"sequence":1,"eventId":"e","payload":{"x":1}}],"event_sequences":{"e":0}}}}).to_string();
        c.execute("INSERT INTO job_authority VALUES(1,?1)", [blob])
            .unwrap();
        drop(c);
        let a = PersistentAuthority::open(&p).unwrap();
        assert_eq!(a.snapshot("old").unwrap().last_sequence, 1);
        assert_eq!(
            a.connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            7
        );
        drop(a);
        PersistentAuthority::open(&p).unwrap();
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn late_v1_migration_failure_rolls_back_normalized_schema_and_data() {
        let (d, p) = db();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(1); CREATE TABLE job_authority(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL); CREATE TRIGGER fail_v5 BEFORE INSERT ON schema_migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        let blob = json!({"jobs":{"old":{"state":"queued","lease":null,"next_lease_generation":1,"events":[{"sequence":1,"eventId":"e","payload":{"x":1}}]}}}).to_string();
        c.execute("INSERT INTO job_authority VALUES(1,?1)", [&blob])
            .unwrap();
        drop(c);

        assert!(matches!(
            PersistentAuthority::open(&p),
            Err(AuthorityError::Storage)
        ));

        let c = Connection::open(&p).unwrap();
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row("SELECT state_json FROM job_authority WHERE id=1", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            blob
        );
        let normalized_count: u64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('jobs','runs','job_events')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(normalized_count, 0);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn malformed_v1_blob_rolls_back_migration() {
        let (d, p) = db();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(1); CREATE TABLE job_authority(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL); INSERT INTO job_authority VALUES(1,'not json');").unwrap();
        drop(c);
        assert!(matches!(
            PersistentAuthority::open(&p),
            Err(AuthorityError::Storage)
        ));
        let c = Connection::open(&p).unwrap();
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(
            c.query_row("SELECT state_json FROM job_authority WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .is_ok()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn missing_or_invalid_v1_authority_rolls_back_migration() {
        for blob in [
            None,
            Some(
                json!({"jobs":{"old":{"state":"queued","lease":null,"next_lease_generation":1,"events":[{"sequence":1,"eventId":"same","payload":{}},{"sequence":2,"eventId":"same","payload":{}}]}}}).to_string(),
            ),
        ] {
            let (d, p) = db();
            let c = Connection::open(&p).unwrap();
            c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(1); CREATE TABLE job_authority(id INTEGER PRIMARY KEY,state_json TEXT NOT NULL);").unwrap();
            if let Some(blob) = blob {
                c.execute("INSERT INTO job_authority VALUES(1,?1)", [blob])
                    .unwrap();
            }
            drop(c);
            assert!(matches!(
                PersistentAuthority::open(&p),
                Err(AuthorityError::Storage)
            ));
            let c = Connection::open(&p).unwrap();
            assert_eq!(
                c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert!(
                c.query_row(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .is_err()
            );
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[test]
    fn migrates_v2_and_v3_to_v6_atomically() {
        for version in [2, 3] {
            let (d, p) = db();
            let c = Connection::open(&p).unwrap();
            c.execute_batch(&format!(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES({version}); CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, lease_owner TEXT NULL, lease_generation INTEGER NOT NULL DEFAULT 0, next_lease_generation INTEGER NOT NULL DEFAULT 1, worktree_id TEXT NULL, branch TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE runs (run_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, app_session_id TEXT NULL, provider_session_id TEXT NULL); CREATE TABLE job_events (job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(job_id,sequence), UNIQUE(job_id,event_id)); CREATE INDEX job_events_job_sequence ON job_events(job_id,sequence);"
            ))
            .unwrap();
            drop(c);
            let authority = PersistentAuthority::open(&p).unwrap();
            assert_eq!(
                authority
                    .connection
                    .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                7
            );
            authority
                .connection
                .query_row("SELECT base_commit FROM jobs LIMIT 1", [], |_| Ok(()))
                .optional()
                .unwrap();
            drop(authority);
            std::fs::remove_dir_all(d).unwrap();
        }

        let (d, p) = db();
        let c = Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_migrations(version) VALUES(2); CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, lease_owner TEXT NULL, lease_generation INTEGER NOT NULL, next_lease_generation INTEGER NOT NULL, worktree_id TEXT NULL, branch TEXT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE runs (run_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL, app_session_id TEXT NULL, provider_session_id TEXT NULL); CREATE TABLE job_events (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(job_id,sequence), UNIQUE(job_id,event_id)); CREATE TRIGGER fail_v5 BEFORE INSERT ON schema_migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        drop(c);
        assert!(matches!(
            PersistentAuthority::open(&p),
            Err(AuthorityError::Storage)
        ));
        let c = Connection::open(&p).unwrap();
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(
            c.query_row("SELECT base_commit FROM jobs LIMIT 1", [], |_| Ok(()))
                .is_err()
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn admission_saga_markers_and_reconciliation() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();

        a.reserve("full", "p", "o", 1).unwrap();
        assert_eq!(
            a.reserve("wait", "p", "o", 1),
            Err(AuthorityError::CapacityExhausted)
        );
        let full_lease = a.snapshot("full").unwrap().lease.unwrap();
        a.finalize("full", &full_lease, "failed", json!(null), JobState::Failed)
            .unwrap();
        let reserved = a.reserve("wait", "p", "o2", 1).unwrap();
        assert_eq!(reserved.state, JobState::Reserved);
        let lease = reserved.lease.unwrap();

        a.prepare("wait", &lease, "/tmp/tree", "job/wait", "base", "/tmp")
            .unwrap();
        a.prepare("wait", &lease, "/tmp/tree", "job/wait", "base", "/tmp")
            .unwrap();
        assert_eq!(
            a.prepare("wait", &lease, "/tmp/other", "job/wait", "base", "/tmp"),
            Err(AuthorityError::WorktreeConflict)
        );
        let admitted = a.admit("wait", &lease, "run", "app").unwrap();
        assert_eq!(admitted.state, JobState::Queued);
        assert_eq!(
            a.admit("wait", &lease, "run", "app").unwrap().state,
            JobState::Queued
        );
        a.bind_provider_session("wait", &lease, "run", "provider")
            .unwrap();
        a.bind_provider_session("wait", &lease, "run", "provider")
            .unwrap();
        assert_eq!(
            a.bind_provider_session("wait", &lease, "run", "other"),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(
            a.finalize(
                "wait",
                &lease,
                "admission-failed",
                json!(null),
                JobState::Failed
            )
            .unwrap()
            .state,
            JobState::Failed
        );

        a.reserve("bare", "p", "o", 64).unwrap();
        a.reserve("prepared", "p", "o", 64).unwrap();
        let prepared_lease = a.snapshot("prepared").unwrap().lease.unwrap();
        a.prepare(
            "prepared",
            &prepared_lease,
            "/tmp/prepared-tree",
            "job/prepared",
            "base",
            "/tmp",
        )
        .unwrap();
        a.reserve("queued", "p", "o", 64).unwrap();
        let queued_lease = a.snapshot("queued").unwrap().lease.unwrap();
        a.prepare(
            "queued",
            &queued_lease,
            "/tmp/queued-tree",
            "job/queued",
            "base",
            "/tmp",
        )
        .unwrap();
        a.admit("queued", &queued_lease, "queued-run", "queued-app")
            .unwrap();
        let changed = a.reconcile().unwrap();
        assert_eq!(changed.changed_count, 3);
        assert_eq!(changed.job_ids.len(), 3);
        assert_eq!(a.snapshot("bare").unwrap().state, JobState::Interrupted);
        let prepared = a.snapshot("prepared").unwrap();
        assert_eq!(prepared.state, JobState::Interrupted);
        assert_eq!(prepared.worktree_id.as_deref(), Some("/tmp/prepared-tree"));
        assert_eq!(prepared.base_commit.as_deref(), Some("base"));
        assert_eq!(prepared.repository_root.as_deref(), Some("/tmp"));
        assert_eq!(a.snapshot("queued").unwrap().state, JobState::Interrupted);

        let readmitted = a
            .readmit("queued", "new-owner", "new-run", "new-app", 64)
            .unwrap();
        assert_eq!(readmitted.state, JobState::Queued);
        assert_eq!(
            a.connection
                .query_row("SELECT COUNT(*) FROM runs WHERE job_id='queued'", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            2
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn cancel_admission_releases_binding_and_capacity_before_running() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let reserved = a.reserve_start("j", "p", "app", "owner", None, 1).unwrap();
        let lease = reserved.lease.unwrap();
        let cancelled = a
            .cancel_admission(
                "j",
                &lease,
                "admission-cancelled",
                json!({"kind":"failed"}),
                Some(TerminalEvent {
                    event_id: "run-terminal:run-1".to_owned(),
                    payload: json!({"kind":"job_terminal","outcome":"failed"}),
                }),
            )
            .unwrap();
        assert_eq!(cancelled.snapshot.state, JobState::Failed);
        assert!(cancelled.snapshot.lease.is_none());
        assert_eq!(
            cancelled.terminal_event,
            Some(JobEvent {
                sequence: 2,
                event_id: "run-terminal:run-1".to_owned(),
                payload: json!({"kind":"job_terminal","outcome":"failed"}),
            })
        );
        assert_eq!(
            a.replay("j", 0, DEFAULT_REPLAY_BUDGET, "reply")
                .unwrap()
                .events,
            vec![
                JobEvent {
                    sequence: 1,
                    event_id: "admission-cancelled".to_owned(),
                    payload: json!({"kind":"failed"})
                },
                JobEvent {
                    sequence: 2,
                    event_id: "run-terminal:run-1".to_owned(),
                    payload: json!({"kind":"job_terminal","outcome":"failed"})
                },
            ]
        );
        assert_eq!(a.resolve_binding("p", "app"), Err(AuthorityError::NotFound));
        assert_eq!(
            a.reserve("replacement", "p", "owner", 1).unwrap().state,
            JobState::Reserved
        );

        let queued_lease = a.snapshot("replacement").unwrap().lease.unwrap();
        a.prepare(
            "replacement",
            &queued_lease,
            "/canonical/worktree",
            "job/replacement",
            "base",
            "/canonical",
        )
        .unwrap();
        a.admit("replacement", &queued_lease, "run", "app").unwrap();
        assert_eq!(
            a.cancel_admission(
                "replacement",
                &queued_lease,
                "cancel-queued",
                json!(null),
                None
            )
            .unwrap()
            .snapshot
            .state,
            JobState::Failed
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn cancel_admission_rejects_running_and_terminal_jobs() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("j", "p", "owner", 2).unwrap();
        let lease = a.snapshot("j").unwrap().lease.unwrap();
        a.prepare(
            "j",
            &lease,
            "/canonical/worktree",
            "job/j",
            "base",
            "/canonical",
        )
        .unwrap();
        a.admit("j", &lease, "run", "app").unwrap();
        a.transition("j", &lease, JobState::Running).unwrap();
        assert_eq!(
            a.cancel_admission("j", &lease, "cancel-running", json!(null), None),
            Err(AuthorityError::InvalidTransition)
        );
        a.finalize("j", &lease, "failed", json!(null), JobState::Failed)
            .unwrap();
        assert_eq!(
            a.cancel_admission("j", &lease, "cancel-terminal", json!(null), None),
            Err(AuthorityError::StaleLease)
        );
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn worktree_run_and_dispatch_checkpoint_are_durable() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        a.reserve("j", "gjc", "o", 4).unwrap();
        let lease = a.snapshot("j").unwrap().lease.unwrap();
        assert_eq!(
            a.prepare("j", &lease, "relative", "job/j", "base", "/canonical"),
            Err(AuthorityError::InvalidIdentifier)
        );
        a.prepare(
            "j",
            &lease,
            "/canonical/worktree",
            "job/j",
            "base",
            "/canonical",
        )
        .unwrap();
        let admitted = a.admit("j", &lease, "r", "app").unwrap();
        assert_eq!(
            admitted.current_run,
            Some(CurrentRun {
                run_id: "r".to_owned(),
                app_session_id: Some("app".to_owned()),
                provider_session_id: None,
            })
        );
        assert_eq!(admitted.dispatch_checkpoint, None);
        let dispatched = a.mark_dispatching("j", &lease, "r").unwrap();
        assert_eq!(
            dispatched.dispatch_checkpoint,
            Some(DispatchCheckpoint {
                run_id: "r".to_owned(),
            })
        );
        a.bind_provider_session("j", &lease, "r", "provider")
            .unwrap();
        assert_eq!(
            a.snapshot("j")
                .unwrap()
                .current_run
                .unwrap()
                .provider_session_id,
            Some("provider".to_owned())
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn reconcile_mutates_all_jobs_but_bounds_job_ids() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        for number in 0..=MAX_RECONCILE_JOB_IDS {
            a.connection
                .execute(
                    "INSERT INTO jobs(id,provider,state,lease_owner,lease_generation,next_lease_generation) VALUES(?1,'p','reserved','o',1,2)",
                    [format!("j{number:03}")],
                )
                .unwrap();
        }
        let result = a.reconcile().unwrap();
        assert_eq!(result.changed_count, (MAX_RECONCILE_JOB_IDS + 1) as u64);
        assert_eq!(result.job_ids.len(), MAX_RECONCILE_JOB_IDS);
        assert_eq!(
            a.list(
                Some(JobState::Reserved),
                None,
                None,
                100,
                DEFAULT_LIST_BUDGET,
            )
            .unwrap()
            .items
            .len(),
            0
        );
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn v5_binding_turn_finalize_and_shutdown() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let reserved = a.reserve_start("j", "p", "app", "owner", None, 2).unwrap();
        assert_eq!(reserved.state, JobState::Reserved);
        assert_eq!(
            a.reserve_start("other", "p", "app", "owner", None, 2),
            Err(AuthorityError::AlreadyExists)
        );
        let lease = a.snapshot("j").unwrap().lease.unwrap();
        a.prepare(
            "j",
            &lease,
            "/canonical/worktree",
            "job/j",
            "base",
            "/canonical",
        )
        .unwrap();
        a.admit("j", &lease, "r1", "app").unwrap();
        a.finalize_run("j", &lease, "r1", JobState::Succeeded, "done", json!(null))
            .unwrap();
        assert_eq!(a.snapshot("j").unwrap().state, JobState::Ready);
        let admitted = a.turn_admit("j", "app", "owner-2", "r2", 2).unwrap();
        assert_eq!(admitted.state, JobState::Queued);
        assert_eq!(a.resolve_binding("p", "app").unwrap().job_id, "j");
        let result = a.interrupt_for_shutdown().unwrap();
        assert_eq!(result.changed_count, 1);
        assert_eq!(a.snapshot("j").unwrap().state, JobState::Interrupted);
        assert_eq!(
            a.connection
                .query_row("SELECT state FROM runs WHERE run_id='r2'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "interrupted"
        );
        let events = a.replay("j", 0, 999, "test").unwrap().events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_id == "shutdown-interrupted:r2")
                .count(),
            1
        );
        a.release_binding("j").unwrap();
        assert_eq!(a.resolve_binding("p", "app"), Err(AuthorityError::NotFound));
        std::fs::remove_dir_all(d).unwrap();
    }

    fn admit_test_run(authority: &mut PersistentAuthority) -> Lease {
        let lease = authority
            .reserve_start("j", "p", "app", "owner", None, 4)
            .unwrap()
            .lease
            .unwrap();
        authority
            .prepare("j", &lease, "/tmp/tree", "job/j", "base", "/tmp")
            .unwrap();
        authority.admit("j", &lease, "r1", "app").unwrap();
        authority
            .transition("j", &lease, JobState::Running)
            .unwrap();
        lease
    }

    #[test]
    fn a_readmitted_lease_cannot_mutate_the_previous_run() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let old_lease = admit_test_run(&mut a);
        a.transition("j", &old_lease, JobState::Interrupted)
            .unwrap();
        let current = a.readmit("j", "next-owner", "r2", "app", 4).unwrap();
        let lease = current.lease.as_ref().unwrap();
        assert_eq!(
            a.append_event_for_run("j", lease, "r1", "late-output", json!("old")),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(
            a.bind_provider_session("j", lease, "r1", "old-provider-session"),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(
            a.mark_dispatching("j", lease, "r1"),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(
            a.finalize_run(
                "j",
                lease,
                "r1",
                JobState::Succeeded,
                "late-final",
                json!(null)
            ),
            Err(AuthorityError::InvalidTransition)
        );
        assert_eq!(a.snapshot("j").unwrap(), current);
        assert_eq!(
            a.resolve_binding("p", "app").unwrap().provider_session_id,
            None
        );
        a.bind_provider_session("j", lease, "r2", "current-provider-session")
            .unwrap();
        a.mark_dispatching("j", lease, "r2").unwrap();
        a.append_event_for_run("j", lease, "r2", "current-output", json!("new"))
            .unwrap();
        assert_eq!(
            a.finalize_run(
                "j",
                lease,
                "r2",
                JobState::Succeeded,
                "current-final",
                json!(null)
            )
            .unwrap()
            .state,
            JobState::Ready
        );
        drop(a);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn event_retries_cannot_reassign_history_to_another_run() {
        let (d, p) = db();
        let mut a = PersistentAuthority::open(&p).unwrap();
        let lease = admit_test_run(&mut a);
        let event = a
            .append_event_for_run("j", &lease, "r1", "shared-event", json!(1))
            .unwrap();
        assert_eq!(
            a.append_event_for_run("j", &lease, "r1", "shared-event", json!(1))
                .unwrap(),
            event
        );
        a.finalize_run(
            "j",
            &lease,
            "r1",
            JobState::Succeeded,
            "r1-final",
            json!(null),
        )
        .unwrap();
        let current = a.turn_admit("j", "app", "next-owner", "r2", 4).unwrap();
        let lease = current.lease.as_ref().unwrap();
        assert_eq!(
            a.append_event_for_run("j", lease, "r2", "shared-event", json!(1)),
            Err(AuthorityError::EventConflict)
        );
        assert_eq!(
            a.finalize_run(
                "j",
                lease,
                "r2",
                JobState::Succeeded,
                "r1-final",
                json!(null)
            ),
            Err(AuthorityError::EventConflict)
        );
        assert_eq!(a.snapshot("j").unwrap(), current);
        let run: String = a
            .connection
            .query_row(
                "SELECT run_id FROM job_events WHERE event_id='shared-event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(run, "r1");
        assert_eq!(
            a.finalize_run(
                "j",
                lease,
                "r2",
                JobState::Succeeded,
                "r2-final",
                json!(null)
            )
            .unwrap()
            .state,
            JobState::Ready
        );
        drop(a);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn accepts_a_64_kib_request_body() {
        let (d, p) = db();
        let prefix = r#"{"protocolVersion":1,"id":"frame","method":"job.list","afterCursor":""#;
        let suffix = r#""}"#;
        let body = format!(
            "{prefix}{}{suffix}",
            "x".repeat(MAX_FRAME_BYTES - prefix.len() - suffix.len())
        );
        assert_eq!(body.len(), MAX_FRAME_BYTES);
        let mut output = Vec::new();
        assert!(run(
            &p,
            std::io::Cursor::new(format!("{body}\n").into_bytes()),
            &mut output,
        ));
        assert!(!output.is_empty());
        std::fs::remove_dir_all(d).unwrap();
    }
}
