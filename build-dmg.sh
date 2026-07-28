#!/bin/bash
# Build & Open DMG for Dawn Fresh Game
# Generated 100% manually - no OpenCode-CLI

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "[$(date '+%H:%M:%S')] $*"; }

# Kill any running processes
log "Stopping any running processes..."
pkill -f "electron" || true
pkill -f "dawn" || true
sleep 2

# Clean build environment
log "Cleaning build environment..."
rm -rf build/ node_modules/.bin/electron node_modules/.bin/electron-builder

# Install dependencies
log "Installing dependencies..."
npm install --legacy-peer-deps --production=false

# Verify Electron is installed
electron_version=$(electron --version)
log "Electron version: $electron_version"

# Create DMG directory structure
log "Creating DMG structure..."
mkdir -p "dawn-game-dmg/dawn.app/Contents/{MacOS,Resources}"

# Copy application binary
cp -r "dist/".* "dawn-game-dmg/dawn.app/Contents/MacOS/" 2>/dev/null || {
    log "Building application with electron-builder..."
    npx electron-builder --mac --dir --out=build/mac-desktop
    cp -r "build/mac-desktop/Dawn Fresh.app" "dawn-game-dmg/dawn.app"
}

# Copy resources
cp -r "src/assets/"* "dawn-game-dmg/dawn.app/Contents/Resources/" || true

# Create DMG script
cat > "create-dmg.sh" << 'EOF'
# Create DMG script
DMG_PATH="Dawn_Fresh_v1.0.dmg"
VOLUME_NAME="Dawn Fresh"

rm -f "$DMG_PATH"

# Mount overlay volume
dmg create "dawn-game-dmg"
EOF

chmod +x "create-dmg.sh"

# Execute DMG creation
log "Creating DMG..."
eval ".\
$(cat \"create-dmg.sh\")"

DMG_PATH="Dawn_Fresh_v1.0.dmg"
if [[ -f "$DMG_PATH" ]]; then
    log "\n${GREEN}✅ DMG Created Successfully:${NC} $DMG_PATH"
    log "\n${YELLOW}Contents:${NC}"
    hdiutil info "$DMG_PATH" | grep "^/+"
    
    # Open DMG
    log "\n${BLUE}Opening DMG...${NC}"
    open "$DMG_PATH"
else
    log "${RED}❌ DMG creation failed!${NC}"
    exit 1
fi

log "\n${GREEN}🎮 Dawn Fresh DMG ready! Launching...${NC}"
open "$DMG_PATH"
