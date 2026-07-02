# Shunt justfile

set dotenv-load := false

# List available recipes
default:
    @just --list

# ─── Build ────────────────────────────────────────────

# Build Native Host (Rust, release)
build:
    cd host && cargo build --release

# Build CLI (TypeScript → binary)
build-cli:
    cd cli && bun build shunt.ts --compile --outfile shunt

# ─── Setup ────────────────────────────────────────────

# Build + register Native Messaging host for Helium
register: build
    bash host/register.sh

# Remove Native Messaging registration
unregister:
    rm -f ~/Library/Application\ Support/net.imput.helium/NativeMessagingHosts/com.opensetsuna.shunt.json

# ─── Test ─────────────────────────────────────────────

# Test CLI connectivity through the browser-backed native host
test-host:
    cd cli && bun shunt.ts ping

# ─── Code Quality ─────────────────────────────────────

# Format all code
format:
    @bunx biome format --write .

# Lint check
lint:
    @bunx biome check .

# Lint and fix
lint-fix:
    @bunx biome check --write .
