const GITHUB_RELEASE_BASE =
  "https://github.com/zhacker-tech/zhacker/releases/latest/download";

export const downloadLinks = {
  macos: `${GITHUB_RELEASE_BASE}/ZHACKER-universal.dmg`,
  windows: `${GITHUB_RELEASE_BASE}/ZHACKER-windows-x64.exe`,
  linuxAppImage: `${GITHUB_RELEASE_BASE}/ZHACKER-linux-x64.AppImage`,
  linuxArm64AppImage: `${GITHUB_RELEASE_BASE}/ZHACKER-linux-arm64.AppImage`,
  linuxDeb: `${GITHUB_RELEASE_BASE}/ZHACKER-linux-x64.deb`,
  linuxArm64Deb: `${GITHUB_RELEASE_BASE}/ZHACKER-linux-arm64.deb`,
};
