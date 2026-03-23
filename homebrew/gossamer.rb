cask "gossamer" do
  version "GOSSAMER_VERSION"

  on_arm do
    sha256 "GOSSAMER_ARM64_SHA256"
    url "https://github.com/nosman/gossamer/releases/download/v#{version}/Gossamer-#{version}-arm64.dmg"
  end

  on_intel do
    sha256 "GOSSAMER_X64_SHA256"
    url "https://github.com/nosman/gossamer/releases/download/v#{version}/Gossamer-#{version}.dmg"
  end

  name "Gossamer"
  desc "Browse and search your Claude Code sessions locally"
  homepage "https://github.com/nosman/gossamer"

  app "Gossamer.app"
end
