//! Cancellation registry for native file jobs.
//!
//! The UI's `jobId` is the handle. `engine_run_file_tool` registers a flag when a
//! job starts, and [`cancel_native_job`] sets it. Two properties matter: a job
//! that has already finished cannot be re-cancelled (its flag is gone, so a late
//! click cannot mark an unrelated future job with the same id), and the engine can
//! ask "should I stop?" at every boundary it already reports progress for.
//!
//! Cancellation is cooperative: it stops work at the next file or artifact
//! boundary rather than mid-parse, and the host refuses to write official output
//! once the flag is set, which is what makes "cancelled" a truthful end state
//! instead of a UI label.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

#[derive(Default)]
pub struct JobCancels {
    flags: RwLock<HashMap<String, Arc<AtomicBool>>>,
}

impl JobCancels {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start tracking one job. The returned flag is what the engine polls; the
    /// registration removes the entry when the command body finishes, however it
    /// finishes (success, failure, panic unwind included).
    pub fn register(&self, job_id: &str) -> (Arc<AtomicBool>, Registration<'_>) {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut live) = self.flags.write() {
            live.insert(job_id.to_string(), Arc::clone(&flag));
        }
        (
            flag,
            Registration {
                job_id: job_id.to_string(),
                table: self,
            },
        )
    }

    /// Mark a running job as cancelled. `false` means no native job with that id
    /// is running here — the caller's own state still moves to `cancelled`, and
    /// the terminal guard in the runner keeps any late reply from reversing it.
    pub fn cancel(&self, job_id: &str) -> bool {
        let live = self.flags.read();
        match live
            .as_ref()
            .ok()
            .and_then(|flags| flags.get(job_id).cloned())
        {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    fn release(&self, job_id: &str) {
        if let Ok(mut flags) = self.flags.write() {
            flags.remove(job_id);
        }
    }
}

pub struct Registration<'a> {
    job_id: String,
    table: &'a JobCancels,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.table.release(&self.job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_job_can_be_cancelled_once_and_its_flag_is_shared() {
        let table = JobCancels::new();
        let (flag, _registration) = table.register("job-1");
        assert!(!flag.load(Ordering::SeqCst));
        assert!(table.cancel("job-1"));
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_an_unknown_or_finished_job_marks_nothing() {
        let table = JobCancels::new();
        assert!(!table.cancel("never-ran"));
        {
            let (flag, _registration) = table.register("job-2");
            assert!(table.cancel("job-2"));
            assert!(flag.load(Ordering::SeqCst));
        }
        // The registration is gone with the job, so a late click cannot reach an
        // unrelated job that later reuses the id.
        assert!(!table.cancel("job-2"));
        let (flag, _registration) = table.register("job-2");
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn jobs_do_not_see_each_other_cancellation() {
        let table = JobCancels::new();
        let (first, _first_guard) = table.register("job-a");
        let (second, _second_guard) = table.register("job-b");
        table.cancel("job-a");
        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }
}
