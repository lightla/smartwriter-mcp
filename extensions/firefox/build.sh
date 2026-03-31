#!/bin/bash
set -e

# Run tsup
npx tsup src/background.ts src/content.ts src/popup.ts --format iife --splitting false --target es2022 --outDir dist

# Rename the output files
mv dist/background.global.js dist/background.js
mv dist/content.global.js dist/content.js
mv dist/popup.global.js dist/popup.js

# Copy static files
cp src/popup.html dist/popup.html
cp manifest.json dist/manifest.json

echo "Build completed successfully!"
