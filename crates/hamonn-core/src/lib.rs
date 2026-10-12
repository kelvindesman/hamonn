//! hamonn kernel — the *functional core* of the landing layer.
//!
//! Zero I/O, zero async, zero clocks: every function is `(facts) -> Result<decision, KernelError>`.
//! The TypeScript shell gathers facts through ports, calls the kernel for every decision, and
//! persists the result. If a rule needs a test, it lives here.

pub mod api;
pub mod claims;
pub mod domain;
pub mod error;
pub mod evaluate;
pub mod ledger;
pub mod lifecycle;
pub mod state;
pub mod vectors;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use api::call;
pub use error::KernelError;

pub const KERNEL_VERSION: &str = env!("CARGO_PKG_VERSION");
