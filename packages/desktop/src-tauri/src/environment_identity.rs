use std::{fs, io::Write, path::Path};
use tauri::Manager;

fn read_id(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let id = uuid::Uuid::parse_str(raw.trim()).map_err(|error| error.to_string())?;
    if id.get_version_num() != 4 {
        return Err("Invalid environment identity version".into());
    }
    Ok(id.to_string())
}

fn load_or_create(directory: &Path) -> Result<String, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join("environment-id");
    match fs::metadata(&path) {
        Ok(_) => return read_id(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let id = uuid::Uuid::new_v4().to_string();
    let temporary = directory.join(format!(".environment-id-{id}"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        writeln!(file, "{id}").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        read_id(&path)
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[tauri::command]
pub fn get_environment_id(app: tauri::AppHandle) -> Result<String, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    load_or_create(&directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_starts_and_restarts_keep_the_same_identity() {
        let directory =
            std::env::temp_dir().join(format!("hackerai-identity-{}", uuid::Uuid::new_v4()));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let directory = directory.clone();
                std::thread::spawn(move || load_or_create(&directory).unwrap())
            })
            .collect();
        let ids: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(load_or_create(&directory).unwrap(), ids[0]);
        fs::write(directory.join("environment-id"), "").unwrap();
        assert!(load_or_create(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
