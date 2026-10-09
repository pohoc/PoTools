//! Optional progress reporting from long-running tools.
//!
//! Tools that iterate over outputs (split groups, extraction ranges, …) call
//! [`report`] with coarse `(done, total)` pairs. Whether anyone listens is the
//! host's decision: the wasm worker and the desktop command install a sink
//! around `run_tool` for the duration of one call, while plain library callers
//! (tests, other embedders) never install one and reporting is a no-op.
//!
//! A module-level sink keeps `RunContext` unchanged — a callback field there
//! would touch every construction site across the engine, the wasm ABI and the
//! desktop host for a value only two adapters ever set. The sink is
//! thread-local on purpose: a tool body runs synchronously on one thread, so
//! concurrent desktop jobs never see each other's sink.

use std::cell::RefCell;
use std::rc::Rc;

pub type Sink = Rc<dyn Fn(usize, usize)>;

thread_local! {
    static CURRENT: RefCell<Option<Sink>> = const { RefCell::new(None) };
}

struct Restore(Option<Sink>);

impl Drop for Restore {
    fn drop(&mut self) {
        CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}

/// Installs `sink` for the duration of `run`, restoring whatever was installed
/// before — including on panic, so a guard never leaks into the next job.
pub fn with<T>(sink: Option<Sink>, run: impl FnOnce() -> T) -> T {
    let previous = CURRENT.with(|slot| slot.replace(sink));
    let _restore = Restore(previous);
    run()
}

/// Reports one progress step to the installed sink, if any. `done` starts at 1
/// after the first finished unit; `total` is the number of units.
pub fn report(done: usize, total: usize) {
    // Cloned out so the sink can re-enter `with` (e.g. nested tool dispatch)
    // without hitting the borrow in flight.
    let sink = CURRENT.with(|slot| slot.borrow().clone());
    if let Some(sink) = sink {
        sink(done, total);
    }
}
