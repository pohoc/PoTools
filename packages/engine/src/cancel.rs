//! Cooperative cancellation for long-running native jobs.
//!
//! The desktop host owns the flag (a `JobCancels` registry keyed by `jobId`) and
//! installs a reader here for the duration of one `run_tool` call, exactly like
//! [`crate::progress`]. Tools that already report progress between units call
//! [`check`] at the same points, so a cancelled batch stops at the next file
//! instead of grinding through work whose result nobody may publish.
//!
//! The token is deliberately thread-local: a tool body runs synchronously on one
//! thread, so concurrent desktop jobs never see each other's flag, and library
//! callers that install nothing simply keep [`cancelled`] returning `false`.

use std::cell::RefCell;
use std::rc::Rc;

use crate::EngineError;

pub type Token = Rc<dyn Fn() -> bool>;

thread_local! {
    static CURRENT: RefCell<Option<Token>> = const { RefCell::new(None) };
}

struct Restore(Option<Token>);

impl Drop for Restore {
    fn drop(&mut self) {
        CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}

/// Installs `token` for the duration of `run`, restoring whatever was installed
/// before — including on panic, so a guard never leaks into the next job.
///
/// Passing `None` leaves the installed token alone rather than clearing it: a tool
/// that dispatches another tool must not silently lose the caller's cancellation.
pub fn with<T>(token: Option<Token>, run: impl FnOnce() -> T) -> T {
    let Some(token) = token else { return run() };
    let previous = CURRENT.with(|slot| slot.replace(Some(token)));
    let _restore = Restore(previous);
    run()
}

/// True when the surrounding job has been cancelled.
pub fn cancelled() -> bool {
    CURRENT.with(|slot| slot.borrow().as_ref().is_some_and(|token: &Token| token()))
}

/// Engine-side gate: return a structured `cancelled` failure once the host has
/// asked for this job to stop. `code` stays `'cancelled'` so the host can tell a
/// cancellation apart from a real failure and refuse to write official output.
pub fn check() -> Result<(), EngineError> {
    if cancelled() {
        Err(EngineError::new(
            "cancelled",
            "任务已取消，未再处理后续内容".to_string(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn no_token_means_nothing_is_cancelled() {
        assert!(!cancelled());
        assert!(check().is_ok());
    }

    #[test]
    fn an_installed_token_decides_and_the_guard_restores_the_previous_one() {
        let flag = Rc::new(Cell::new(false));
        let reader: Token = {
            let flag = Rc::clone(&flag);
            Rc::new(move || flag.get())
        };
        with(Some(reader), || {
            assert!(!cancelled());
            flag.set(true);
            assert!(cancelled());
            let error = check().unwrap_err();
            assert_eq!(error.code, "cancelled");
            // A nested scope without a token keeps the outer one, so a tool that
            // dispatches another tool does not lose the cancellation.
            with(None as Option<Token>, || assert!(cancelled()));
        });
        assert!(!cancelled());
        assert!(check().is_ok());
    }
}
