//! Reading from disk, with the limits that keep the web side from reaching
//! anywhere the user didn't point it: samples only from folders they chose,
//! and only audio files of a sensible size.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

const AUDIO: [&str; 8] = ["wav", "aif", "aiff", "mp3", "ogg", "flac", "m4a", "opus"];
const MAX_SAMPLE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_PROJECT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const MAX_DEPTH: usize = 6;

#[derive(Serialize, Debug, PartialEq)]
pub struct AudioFile {
    /// Full path, for `read`.
    pub path: String,
    /// Path inside the folder, with forward slashes, for showing.
    pub name: String,
    pub size: u64,
}

fn has_ext(path: &Path, allowed: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| allowed.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

pub fn is_project(path: &Path) -> bool {
    has_ext(path, &["loopwell"]) && path.is_file()
}

pub fn read_project(path: &Path) -> Result<Vec<u8>, String> {
    if !is_project(path) {
        return Err("That is not a Loopwell project file.".into());
    }
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_PROJECT_BYTES {
        return Err("That file is too big to be a Loopwell project.".into());
    }
    fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// The sample folders the user has added.
#[derive(Default)]
pub struct Library {
    roots: Vec<PathBuf>,
}

impl Library {
    pub fn load(file: &Path) -> Self {
        let saved: Vec<String> = fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        // a folder that has gone away since last time is simply dropped
        Library { roots: saved.iter().filter_map(|p| fs::canonicalize(p).ok()).filter(|p| p.is_dir()).collect() }
    }

    pub fn save(&self, file: &Path) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, serde_json::to_string(&self.folders()).unwrap_or_default());
    }

    pub fn folders(&self) -> Vec<String> {
        self.roots.iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }

    pub fn add(&mut self, folder: &Path) -> Result<String, String> {
        let real = fs::canonicalize(folder).map_err(|e| format!("Could not open that folder: {e}"))?;
        if !real.is_dir() {
            return Err("That is not a folder.".into());
        }
        if !self.roots.contains(&real) {
            self.roots.push(real.clone());
        }
        Ok(real.to_string_lossy().into_owned())
    }

    pub fn remove(&mut self, folder: &str) {
        self.roots.retain(|p| p.to_string_lossy() != folder);
    }

    fn root_of(&self, path: &Path) -> Option<&PathBuf> {
        self.roots.iter().find(|r| path.starts_with(r))
    }

    /// Every audio file under a chosen folder, sorted by name.
    pub fn list(&self, folder: &str) -> Result<Vec<AudioFile>, String> {
        let root = self.roots.iter().find(|p| p.to_string_lossy() == folder).ok_or("That folder has not been added.")?;
        let mut out = Vec::new();
        walk(root, root, 0, &mut out);
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

    /// The bytes of an audio file inside one of the chosen folders. Links that lead outside are refused.
    pub fn read(&self, path: &str) -> Result<Vec<u8>, String> {
        let real = fs::canonicalize(path).map_err(|_| "That file is not there any more.".to_string())?;
        if self.root_of(&real).is_none() {
            return Err("That file is outside your sample folders.".into());
        }
        if !has_ext(&real, &AUDIO) {
            return Err("That is not an audio file.".into());
        }
        let size = fs::metadata(&real).map_err(|e| e.to_string())?.len();
        if size > MAX_SAMPLE_BYTES {
            return Err("That file is too big to use as a sample (25 MB max).".into());
        }
        fs::read(&real).map_err(|e| format!("Could not read the file: {e}"))
    }
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<AudioFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        // file_type() does not follow links, so a link can't lead the walk out of the folder
        let Ok(kind) = entry.file_type() else { continue };
        if hidden || kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                walk(root, &path, depth + 1, out);
            }
        } else if has_ext(&path, &AUDIO) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if size == 0 || size > MAX_SAMPLE_BYTES {
                continue;
            }
            let name = path.strip_prefix(root).unwrap_or(&path).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            out.push(AudioFile { path: path.to_string_lossy().into_owned(), name, size });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("drums/Kicks")).unwrap();
        fs::write(dir.path().join("drums/Kicks/Big.WAV"), b"RIFFxxxx").unwrap();
        fs::write(dir.path().join("drums/snare.flac"), b"fLaC").unwrap();
        fs::write(dir.path().join("alpha.mp3"), b"ID3").unwrap();
        fs::write(dir.path().join("notes.txt"), b"hello").unwrap();
        fs::write(dir.path().join("empty.wav"), b"").unwrap();
        fs::write(dir.path().join(".hidden.wav"), b"RIFF").unwrap();
        dir
    }

    #[test]
    fn lists_audio_files_in_chosen_folders_only() {
        let dir = folder();
        let mut lib = Library::default();
        assert!(lib.list(&dir.path().to_string_lossy()).is_err());
        let root = lib.add(dir.path()).unwrap();
        let names: Vec<String> = lib.list(&root).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["alpha.mp3", "drums/Kicks/Big.WAV", "drums/snare.flac"]);
        assert_eq!(lib.folders(), [root.clone()]);
        lib.add(dir.path()).unwrap();
        assert_eq!(lib.folders().len(), 1);
        lib.remove(&root);
        assert!(lib.list(&root).is_err());
    }

    #[test]
    fn reads_only_audio_inside_the_folders() {
        let dir = folder();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.wav"), b"RIFFsecret").unwrap();
        let mut lib = Library::default();
        let root = lib.add(dir.path()).unwrap();
        let inside = format!("{root}/drums/Kicks/Big.WAV");
        assert_eq!(lib.read(&inside).unwrap(), b"RIFFxxxx");
        assert!(lib.read(&format!("{root}/notes.txt")).unwrap_err().contains("not an audio file"));
        assert!(lib.read(&outside.path().join("secret.wav").to_string_lossy()).unwrap_err().contains("outside"));
        assert!(lib.read(&format!("{root}/drums/../../{}/secret.wav", outside.path().file_name().unwrap().to_string_lossy())).is_err());
        assert!(lib.read(&format!("{root}/gone.wav")).unwrap_err().contains("not there"));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links_out_of_a_folder() {
        let dir = folder();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.wav"), b"RIFFsecret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.wav"), dir.path().join("link.wav")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked-dir")).unwrap();
        let mut lib = Library::default();
        let root = lib.add(dir.path()).unwrap();
        let names: Vec<String> = lib.list(&root).unwrap().into_iter().map(|f| f.name).collect();
        assert!(!names.iter().any(|n| n.contains("link")));
        assert!(lib.read(&format!("{root}/link.wav")).unwrap_err().contains("outside"));
    }

    #[test]
    fn remembers_folders_between_runs() {
        let dir = folder();
        let store = tempfile::tempdir().unwrap();
        let file = store.path().join("nested/folders.json");
        let mut lib = Library::default();
        let root = lib.add(dir.path()).unwrap();
        lib.save(&file);
        assert_eq!(Library::load(&file).folders(), [root]);
        drop(dir); // the folder is deleted: it is forgotten rather than causing an error
        assert!(Library::load(&file).folders().is_empty());
        assert!(Library::load(&store.path().join("missing.json")).folders().is_empty());
    }

    #[test]
    fn only_opens_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("Beat.LOOPWELL");
        fs::write(&good, b"PK\x03\x04").unwrap();
        fs::write(dir.path().join("passwd"), b"root").unwrap();
        assert_eq!(read_project(&good).unwrap(), b"PK\x03\x04");
        assert!(read_project(&dir.path().join("passwd")).is_err());
        assert!(read_project(&dir.path().join("missing.loopwell")).is_err());
        assert!(!is_project(dir.path()));
    }
}
