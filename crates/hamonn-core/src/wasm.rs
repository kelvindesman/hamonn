//! wasm-bindgen shim over `api::call` (excluded from native coverage; see `api.rs`).

use wasm_bindgen::prelude::*;

/// `call(name, jsonInput) -> jsonOutput`; errors surface as `Error("CODE: message")`.
#[wasm_bindgen]
pub fn call(name: &str, input: &str) -> Result<String, JsError> {
    crate::api::call(name, input).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = kernelVersion)]
pub fn kernel_version() -> String {
    crate::KERNEL_VERSION.to_string()
}

#[wasm_bindgen(js_name = functions)]
pub fn functions() -> String {
    crate::api::FUNCTIONS.join(",")
}
