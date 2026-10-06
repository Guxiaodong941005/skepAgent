These SSH ed25519 keys are public **test-only fixtures**, used for deterministic git signatures
in local simulations. They authenticate no real service and must never be used outside tests.
The human, mac and vps keys have no passphrase. Simulations copy them into their own temporary
directory with private-key permissions and use a local trust root. No provider credentials are
read or represented (ARCHITECTURE D19).

Keep the fixtures fixed: replacing a key changes signed commit hashes for every seed. The
gitleaks allowlist is restricted to this fixture directory.
