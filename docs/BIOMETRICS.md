# Biometrics — how Palm Wallet handles your palm (SIMULATED)

> ⚠️ **Everything in this document describes a PROTOTYPE-GRADE, SIMULATED
> pipeline.** It demonstrates the *shape* of a correct palm-payment system:
> what is stored, what is never stored, where the seams are. The matching
> algorithm itself is a research-grade stand-in. A production deployment must
> replace it with a certified biometric SDK (hardware reader or certified
> phone-vendor stack) behind the same `BiometricService` interface.

## The one rule

> **The palm itself is never treated as a password and never stored — or
> transmitted — as a raw photograph or a reversible feature set.**

Concretely, the system NEVER stores, sends, or accepts:

- raw palm photographs or video frames as the user's credential,
- plaintext feature vectors ("plaintext biometric templates") — **there is no
  API and no code path that accepts descriptors anymore**,
- any reversible representation of the biometric.

What exists instead: each capture device converts its frames into a
**one-way 1024-bit code locally**, and ONLY that code (~172 bytes base64)
crosses the network. The server seals codes with AES-256-GCM at rest. Raw
frames exist only in device memory during capture.

## Where protection happens: ON THE DEVICE

```
capture ──► quality gate ──► extract ──► combine ──► PROTECT (device) ──► code only ──► seal / match (server)
                                              ▲                            ▲
                                        never leaves the device       only artifact on the wire
```

| Stage | Where | What happens | Key facts |
|---|---|---|---|
| **Capture** | device | Phone camera (`getUserMedia`) or dev-only `SyntheticCaptureSource` | Both feed identical downstream code; package runs unchanged in browser & Node |
| **Quality** | device | brightness / contrast / sharpness → score + hints | Unusable captures refused client-side AND server-side |
| **Extract** | device | center-crop → high-pass → illumination normalize → pyramid HOG → population mean-center | 160-dim mean-centered float vector per frame |
| **Combine** | device | average N stable frames (enroll 7, probe 5); stability = consecutive cosine ≥ 0.985 | enrollment also computes min pairwise cosine → self-attested `consistencyScore` |
| **Protect** | **device** | random projection (matrix from HKDF-derived subkey) → sign-binarize → **1024-bit code** | one-way: descriptor cannot be recovered from the sign pattern |
| **Upload** | wire | `{ algoId, version, bits }` + quality metadata — nothing else | byte-length enforced (128 B) at the API edge |
| **Seal** | server | AES-256-GCM under the STORAGE subkey; AAD binds subject+template id | GCM tamper ⇒ `IntegrityError`; DB leak alone yields nothing matchable |
| **Match** | server | popcount Hamming distance → `similarity = 1 − dist/bits` | decrypted bits held ephemerally in memory only |

### Key separation (HKDF purpose separation)

Both runtime keys derive from `TEMPLATE_MASTER_KEY` via WebCrypto HKDF-SHA-256
with distinct info labels (`protect/keys.ts`) — they are computationally
independent:

| Subkey | Derived for | Lives where | Compromise impact |
|---|---|---|---|
| **protectionKey** | projection matrix for one-way templating | served to AUTHENTICATED capture clients, held in memory | lets an attacker *create* well-formed probes — but not decrypt anything |
| **storageKey** | AES-256-GCM sealing of templates at rest | server process only; never serialized to any client | with a DB dump, enables offline matching/replay of templates |

Neither equals the master; holding one buys nothing against the other's job.
A unit test proves a protection-key holder cannot open sealed templates.

⚠️ Prototype-grade custody, stated honestly: shipping `protectionKey` to JS
clients means anyone who extracts the app bundle eventually holds it.
Production systems don't ship this key at all — certified readers generate and
hold their own keys in secure hardware (secure element / TEE / KMS-backed).
The authenticated delivery endpoint exists so the *seam* is right and anonymous
callers can't mint well-formed probes.

## Decision thresholds (calibrated on synthetic identities)

| Signal | Value |
|---|---|
| `MATCH_THRESHOLD` | similarity ≥ **0.86** matches |
| Grey zone | 0.76–0.86: reported but rejected as low-confidence |
| Ambiguity margin | two subjects within 0.02 above threshold ⇒ refuse rather than guess |
| Measured separation | genuine pairs min ≈ 0.92 · impostor max ≈ 0.79 |

These numbers are meaningful **for the synthetic population only**. They are not
claims about real palms.

## Score exposure policy (anti-oracle)

- **Payment path (1:N)**: responses carry a coarse band (`high` / `grey` /
  `low`) plus the decision — never a precise similarity score. Exact scores go
  to internal settlement records and the audit chain only.
- **Self-test (1:1, own template)**: the customer may see their own score; it
  reveals nothing about other subjects.
- **Probe throttling**: scan-&-pay attempts are rate-limited per merchant and
  self-tests per customer, bounding how much match information ANY caller can
  harvest over time.
- Every attempt (enroll, self-test, authorize outcome) lands in the hash-chained
  audit log.

## What matching can and cannot do — honest limits

1. **A biometric is not a password.** You rotate a leaked password; you cannot
   re-enroll every palm you've waved at a reader. Compromise response is
   revocation (disable the template), not rotation.
2. **A stored template is not a password hash.** Password hashes work because
   verification is exact — the same string hashes to the same digest. Biometric
   verification is *fuzzy*: two scans of the same palm produce similar-but-
   different codes, so exact-hash equality would reject everyone. Templates
   therefore leak enough structure to compare against, which makes them strictly
   more sensitive than a salted hash. The one-way projection limits what a leak
   *means*, and the separate storage key limits who can use it — but "fuzzy" is
   inherent and unavoidable.
3. **Device-side protection moves trust to the device.** Descriptors never
   transit the network, but a compromised capture device sees raw scans by
   definition (it's the camera path). Certified hardware mitigates this with
   secure elements; a browser PWA cannot fully.
4. **Master key concentration.** Both subkeys derive from `TEMPLATE_MASTER_KEY`.
   Whoever holds it can derive both. Production requires KMS/HSM custody, key
   rotation, and per-template wrapping. Rotation of the *projection* matrix is
   cancelable-biometrics-style re-issue: every user re-enrolls, old codes become
   unlinkable — but that is cold comfort for the palms themselves.
5. **Presentation attacks are out of scope here.** No liveness detection exists
   in the simulated path; real palm readers ship with anti-spoof hardware for
   that reason.
6. **Attested consistency is self-reported.** Because frames never reach the
   server, enrollment repeatability (`consistencyScore`) is computed on-device
   and attested, not verified. The server enforces a floor; a hostile client
   could lie. A certified SDK verifies capture integrity in hardware.

## Alignment note (documented rejection)

Centroid-based ROI alignment was implemented and **rejected** during calibration:
cropping to the palm blob made intra-identity variance *worse* than plain
center-cropping, because small segmentation jitter moved the crop window more
than hand placement did. The extractor therefore uses deterministic center-crop +
high-pass, which proved more robust across jitter/noise/exposure sweeps. This is
the kind of trade-off a certified SDK solves with guided capture + proper
registration — another reason this pipeline stays simulated.

## Where the certified SDK plugs in

```ts
interface BiometricService {            // THE seam (apps/api/src/container.ts)
  readonly algo: { id; version; threshold; greyFloor; bits; dim };
  readonly protectionKeyB64: string;    // device-visible subkey (prototype custody)
  enrollPalm(x): Promise<{ templateId }>;                   // takes a CODE
  verifyPalm(code, { subjectId }): Promise<BestMatchResult>;   // 1:1 self-test
  identifyPalm(code): Promise<BestMatchResult>;                // 1:N scan & pay
  deleteTemplate(templateId): Promise<void>;                // soft revoke
}
```

A vendor SDK implements this against its own store; `packages/db` keeps the row
metadata (subject linkage, status, audit). Nothing else in the stack changes —
and if the SDK captures + matches entirely inside secure hardware, the server
may end up seeing only decisions.
