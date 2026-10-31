fn main() {
    // Tauri embeds Common Controls v6 into application binaries, but not the
    // library test harness or examples. Those otherwise fail before running
    // any Windows test with STATUS_ENTRYPOINT_NOT_FOUND (TaskDialogIndirect).
    println!("cargo:rerun-if-env-changed=HACKERAI_TEST_MANIFEST");
    if std::env::var("HACKERAI_TEST_MANIFEST").as_deref() == Ok("1")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("tests/fixtures/windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::build()
}
