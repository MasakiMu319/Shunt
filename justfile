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

# Test Native Host transport (requires running host manually)
test-host:
    echo '{"type":"ping"}' | nc -U /tmp/shunt.sock

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
