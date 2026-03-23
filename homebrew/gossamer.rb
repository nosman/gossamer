cask "gossamer" do
  version "1.0.0"

  on_arm do
    sha256 "REPLACE_WITH_ARM64_SHA256"
    url "https://github.com/nosman/gossamer/releases/download/v#{version}/Gossamer-#{version}-arm64.dmg"
  end

  on_intel do
    sha256 "REPLACE_WITH_X64_SHA256"
    url "https://github.com/nosman/gossamer/releases/download/v#{version}/Gossamer-#{version}-x64.dmg"
  end

  name "Gossamer"
  desc "Browse and search your Claude Code sessions locally"
  homepage "https://github.com/nosman/gossamer"

  app "Gossamer.app"

  postflight do
    puts <<~EOS
      Gossamer requires the gossamer-serve backend to be running.
      Install it with:
        npm install -g claude-hooks-listener
      Then run:
        gossamer-serve
    EOS
  end
end
