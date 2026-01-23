const GITHUB_RELEASE_BASE =
  "https://github.com/hackerai-tech/hackerai/releases/latest/download";

export const downloadLinks = {
  macos: `${GITHUB_RELEASE_BASE}/HackerAI-universal.dmg`,
  windows: `${GITHUB_RELEASE_BASE}/HackerAI-windows-x64.exe`,
  linuxAppImage: `${GITHUB_RELEASE_BASE}/HackerAI-linux-x64.AppImage`,
  linuxArm64AppImage: `${GITHUB_RELEASE_BASE}/HackerAI-linux-arm64.AppImage`,
};
