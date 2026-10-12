//! `cargo run --bin gen-vectors` — rewrite `tests/vectors/*.json` from `vectors::cases()`.

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors");
    std::fs::create_dir_all(&dir).expect("create vectors dir");
    for (file, body) in hamonn_core::vectors::render_all() {
        std::fs::write(dir.join(&file), body).expect("write vector");
        println!("wrote {file}");
    }
}
