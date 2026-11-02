#!/bin/sh
# Provisions the ubuntu-base rootfs that the wsl-native CI job imports as a WSL1 distro.
# CI caches the exported result keyed on this file's hash, so any edit rebuilds it.
set -eu

# WSL1 file creation is slow and import time scales with file count: skip indexes and files the tests never read.
printf '%s\n' 'Acquire::Languages "none";' 'Acquire::IndexTargets::deb::DEP-11::DefaultEnabled "false";' \
  'Acquire::IndexTargets::deb::CNF::DefaultEnabled "false";' > /etc/apt/apt.conf.d/99claudian-ci
printf '%s\n' 'path-exclude=/usr/share/doc/*' 'path-exclude=/usr/share/man/*' 'path-exclude=/usr/share/locale/*' \
  'path-exclude=/usr/share/fish/completions/*' 'path-exclude=/usr/share/zsh/functions/Completion/*' > /etc/dpkg/dpkg.cfg.d/99claudian-ci
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  bash zsh csh tcsh fish python3 curl ca-certificates
apt-get clean
rm -rf /var/lib/apt/lists/*

# Ubuntu's Node ELF has 8 KiB LOAD alignment, rejected by WSL1.
# This official build uses 4 KiB alignment for every LOAD segment.
archive=/tmp/claudian-wsl-node.tar.gz
curl --fail --silent --show-error --location --retry 3 https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz -o "$archive"
echo "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2  $archive" | sha256sum -c -
mkdir -p /opt/claudian-wsl-node /usr/local/bin
tar -xzf "$archive" --strip-components=1 -C /opt/claudian-wsl-node node-v22.14.0-linux-x64/bin/node
ln -sf /opt/claudian-wsl-node/bin/node /usr/local/bin/node
rm -f "$archive"

mkdir -p /opt/claudian-opencode-v2
cd /opt/claudian-opencode-v2
curl --fail --silent --show-error --location --retry 3 https://opencode.ai/files/bin/2.2.3/opencode-linux-x64-baseline.tar.gz -o opencode.tar.gz
echo 'ef3aeeaf5522b10d69a3da7bbd6e6d8d259f845833d96b8310767d3407b18a35  opencode.tar.gz' | sha256sum -c -
tar -xzf opencode.tar.gz
chmod +x opencode
rm -f opencode.tar.gz
