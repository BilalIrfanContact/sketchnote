//! Failures worded for the user: what went wrong and what to do about it.
//!
//! Code that hits a cause the user can fix attaches a `Fix` (as the error or as context).
//! `explain` turns any error into the one sentence the extension shows; everything else
//! about the error goes to the bundle's `error.txt`.

use std::fmt;

/// A user-facing explanation with a next step, e.g. "ffmpeg isn't installed. …".
#[derive(Debug)]
pub struct Fix(pub String);

impl fmt::Display for Fix {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Fix {}

/// The sentence for `e` if it's a cause we know: its `Fix`, or a full disk.
pub fn known(e: &anyhow::Error) -> Option<String> {
    if let Some(fix) = e.downcast_ref::<Fix>() {
        return Some(fix.0.clone());
    }
    let disk_full = e
        .chain()
        .filter_map(|c| c.downcast_ref::<std::io::Error>())
        .any(|io| io.kind() == std::io::ErrorKind::StorageFull);
    disk_full.then(|| "The disk is full. Free some space, then retry.".into())
}

/// The sentence to show for a failed build: a known cause, else a pointer to the details.
pub fn explain(e: &anyhow::Error, details: &str) -> String {
    known(e).unwrap_or_else(|| format!("Something unexpected went wrong. The details are in {details}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    #[test]
    fn a_fix_anywhere_in_the_chain_is_shown() {
        let e = Err::<(), _>(std::io::Error::from(std::io::ErrorKind::NotFound))
            .context(Fix("ffmpeg isn't installed.".into()))
            .context("converting the video")
            .unwrap_err();
        assert_eq!(explain(&e, "error.txt"), "ffmpeg isn't installed.");
    }

    #[test]
    fn a_full_disk_is_explained_and_anything_else_points_to_the_details() {
        let full = anyhow::Error::from(std::io::Error::from(std::io::ErrorKind::StorageFull)).context("writing");
        assert_eq!(explain(&full, "error.txt"), "The disk is full. Free some space, then retry.");
        let other = anyhow::anyhow!("boom");
        assert_eq!(explain(&other, "x/error.txt"), "Something unexpected went wrong. The details are in x/error.txt.");
    }
}
