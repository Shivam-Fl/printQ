# Mobile Hardening

Use this reference alongside `security-audit.md` — the web checklist covers the backend API surface, which matters equally for mobile apps. This file covers what's *different* or *additional* for mobile: on-device secrets, certificate pinning, OWASP Mobile Top 10, and app store review requirements.

---

## The fundamental difference between web and mobile security

On the web, secrets stay on the server and the browser is a display layer. On mobile, the "client" is a binary that ships to millions of devices, can be decompiled, and runs in an environment the developer doesn't control. This changes the threat model in two important ways:

1. **Anything bundled into the app binary is not secret.** A string literal in Swift, Kotlin, JavaScript (React Native), or Dart (Flutter) is readable by anyone who downloads the app and runs `strings` against it or uses a decompiler. This is not a hypothetical — tools that do this are free and widely used. There is no "secure" way to hide a secret key inside a mobile app binary. The correct answer is to not put secrets in the app at all, and to call a backend endpoint that holds the actual secret.

2. **The network is not trusted.** A user on their own device can route traffic through a proxy, replace TLS certificates, and read every request the app makes — unless the app explicitly pins certificates. This matters for any app handling financial or medical data.

---

## OWASP Mobile Top 10 (2024) — check against each

### M1: Improper Credential Usage

The mobile analogue of secrets-in-code is more severe than the web version — a web server credential in a commit might be found by a scanner; a mobile app credential is decompilable by anyone who downloads the binary from the App Store or Play Store.

**Check**:
```bash
# React Native / JavaScript bundle
grep -rn "sk_\|service_role\|AIza\|AAAA[A-Za-z0-9_\-]" --include="*.ts" --include="*.tsx" --include="*.js" src/

# Flutter/Dart
grep -rn "apiKey\s*=\s*['\"][A-Za-z0-9_\-]{20,}" --include="*.dart" lib/

# native iOS Swift
grep -rn "let.*[Kk]ey\s*=\s*\"[A-Za-z0-9_\-]{20,}\"" --include="*.swift" .

# native Android
grep -rn "val.*[Kk]ey\s*=\s*\"[A-Za-z0-9_\-]{20,}\"" --include="*.kt" --include="*.java" app/
```

Also check `google-services.json` (Android) and `GoogleService-Info.plist` (iOS) — these are frequently committed and contain Firebase API keys and config. The keys themselves are often designed to be shipped (Firebase `api_key` is a project identifier, not a server secret), but if the Firebase security rules are permissive (see security-audit.md #1), shipping these in a public repo is still a problem because anyone can instantiate a Firebase connection using them.

**Fix**: move any secret operation behind a backend endpoint. The mobile app authenticates the user, gets a short-lived session token from the app's own backend, and that backend uses the real secret key to call the third-party API. The mobile app never holds the third-party secret.

---

### M2: Inadequate Supply Chain Security

Mobile apps accumulate SDKs quickly — analytics, crash reporting, A/B testing, ads, social login — and each one is code running with your app's permissions and access to your users' data. AI coding assistants compound this by pulling in packages that look official but may not be.

**Check**: audit every third-party SDK/library (CocoaPods, Gradle dependencies, npm packages for React Native, pub.dev packages for Flutter) for:
- Actual existence and legitimacy (see security-audit.md #17 on hallucinated packages — this is a real risk for mobile AI-generated code)
- Permissions/entitlements requested that aren't needed for the stated functionality (an analytics SDK that requests Contacts access should be a flag)
- Whether it's been updated in the past 12 months (abandoned mobile SDKs are a common vector for outdated-crypto or unpatched-vulnerability issues)

---

### M3: Insecure Authentication / Authorization

**Session management**: mobile sessions tend to be long-lived (users don't "log out" of apps the way they do web sessions), which makes token handling critical.

- **Do not store tokens in plain AsyncStorage (React Native) or SharedPreferences without encryption (Android).** These are plaintext on a rooted/jailbroken device or extractable via adb backup. Use `expo-secure-store` (React Native), iOS Keychain, or Android Keystore.
- **Invalidate server-side** on logout — the server must reject tokens after logout, not just have the client delete its local copy. A token that's "deleted" from the device but still valid server-side is still exploitable from any other device.
- **Implement token refresh**, not permanent tokens. Access tokens should expire (15 minutes to 1 hour for sensitive apps, a few hours for typical apps). Refresh tokens can be longer-lived but should be rotatable and revocable.

**Biometric authentication**: use platform APIs (LocalAuthentication on iOS, BiometricPrompt on Android) — never third-party biometric libraries that transmit biometric data, since biometric data must legally stay on device in most jurisdictions. The biometric check should gate retrieval of a key from the Keychain/Keystore, not a password string — the cryptographic key is what's protected, not a password the app checks for equality.

---

### M5: Insecure Communication

**TLS minimum**: TLS 1.2 minimum in production, TLS 1.3 preferred. Both iOS (ATS) and Android (Network Security Config) now default to requiring TLS 1.2+ and blocking cleartext by default — but this can be and often is overridden during development and left that way. Check for:

```bash
# iOS - has ATS been weakened?
grep -rn "NSAllowsArbitraryLoads\|NSAllowsLocalNetworking\|NSExceptionAllowsInsecureHTTPLoads" --include="*.plist" .

# Android - has cleartext been enabled?
grep -rn "cleartextTrafficPermitted\|usesCleartextTraffic" --include="*.xml" app/
```
If these are set to `true`, confirm it's only for debug builds (acceptable) and not shipping in the production configuration.

**Certificate pinning** — when to require it: pinning is not always the right answer. It breaks whenever the server rotates TLS certificates (which happens routinely), requiring an app update to unpin — if the app isn't updated in time, it stops working for users who haven't updated. For most apps, correct TLS validation (which both platforms provide by default) is sufficient. Pinning is warranted when:
- The app handles financial transactions, medical records, or similarly sensitive data
- The threat model includes sophisticated attackers capable of compromising a certificate authority
- The team has a certificate rotation/pinning update process in place

If pinning is appropriate, pin the public key (not the certificate itself) — keys rotate less frequently than certificates and the app update cadence is lower.

**Fix** (iOS — public key pinning via URLSession delegate):
```swift
func urlSession(_ session: URLSession,
                didReceive challenge: URLAuthenticationChallenge,
                completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard let serverTrust = challenge.protectionSpace.serverTrust,
          let serverCert = SecTrustGetCertificateAtIndex(serverTrust, 0) else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
    }
    let serverKey = SecCertificateCopyKey(serverCert)
    // compare serverKey's data against your pinned public key bytes
}
```

**Fix** (Android — OkHttp CertificatePinner):
```kotlin
val client = OkHttpClient.Builder()
    .certificatePinner(
        CertificatePinner.Builder()
            .add("api.yourapp.com", "sha256/AAAA...yourPublicKeyHash==")
            .build()
    )
    .build()
```

---

### M1/M3/M6: On-device data storage

**Never use**:
- `AsyncStorage` (React Native) unencrypted for anything sensitive
- `SharedPreferences` (Android) without `EncryptedSharedPreferences`
- `UserDefaults` (iOS) for tokens, credentials, or PII — it's not encrypted and is included in unencrypted iCloud backups by default
- SQLite without SQLCipher if the database holds sensitive user data

**Use instead**:
- **iOS**: Keychain (for secrets/tokens) via `SecItemAdd`/`SecItemCopyMatching`, with appropriate `kSecAttrAccessible` constraint — use `kSecAttrAccessibleAfterFirstUnlock` for background-capable apps, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` when you want to exclude iCloud sync and backup
- **Android**: Keystore-backed `EncryptedSharedPreferences` for key-value data, Keystore-backed `EncryptedFile` for larger data
- **React Native**: `expo-secure-store` (wraps Keychain/Keystore), or `react-native-keychain`
- **Flutter**: `flutter_secure_storage`

**Check**:
```bash
# React Native - any direct AsyncStorage calls with sensitive-sounding keys?
grep -rn "AsyncStorage\.(set|get)Item" --include="*.ts" --include="*.tsx" src/ | grep -iE "token|auth|key|secret|password|credential"

# Flutter - any SharedPreferences for sensitive data?
grep -rn "SharedPreferences\|prefs\.set" --include="*.dart" lib/ | grep -iE "token|auth|key|secret|password"
```

---

### M7: Insufficient Binary Protections

**Debug flags in production**: confirm the production build does not have debug logging enabled, debug menu accessible, or `__DEV__` checks that would expose internal state. In React Native, confirm the Metro bundler is not accessible in production builds.

**Code obfuscation**: not a security control in itself (obfuscation is always reversible with enough time), but it raises the cost of reverse engineering and is expected by the Play Store's automated security checks and by many enterprise security reviewers.
- iOS: the Swift/Objective-C compiler strips symbols by default in release builds; check the Archive scheme settings
- Android: ProGuard/R8 should be enabled in `build.gradle` for release builds (`minifyEnabled true`, `shrinkResources true`)
- React Native: Metro's minification handles basic JS obfuscation; for more, `react-native-obfuscating-transformer` is an option

**Root/jailbreak detection**: optionally add detection (via `SafetyNet`/`Play Integrity` on Android, `DeviceCheck`/`App Attest` on iOS) to warn users or restrict sensitive features on compromised devices. This is arms-race-prone (detection can be bypassed), so use it to layer with other controls rather than as a primary security control.

---

## App Store / Play Store requirements

These aren't purely security items but they gate launch — a rejected app doesn't ship — and vibe-coded apps commonly miss them:

**Both stores**:
- Privacy policy required if the app collects any personal data (which nearly all apps do via analytics SDKs at minimum)
- Permission justification strings required for every permission requested — both stores reject apps where the justification doesn't clearly explain why the permission is needed for the app's stated functionality
- No debug API endpoints or test-mode payment flows in the production build submitted for review (reviewers test these)

**iOS (App Store Review)**:
- `Info.plist` must have `NSUserTrackingUsageDescription` if using any SDK that tracks users for advertising (including many analytics SDKs)
- App Transport Security (ATS) exceptions require justification if present in the submission
- In-app purchases for digital goods must go through Apple's IAP system — no redirecting to a web payment page for content consumed in the app

**Android (Play Store)**:
- Target SDK must meet Google's minimum (currently API 34 for new apps, updated annually) — an app built during a vibe-coding session a year ago may already be below the current minimum
- `AndroidManifest.xml` permissions declared but not used are a rejection reason (remove any permissions that were auto-added but aren't actually needed)
- Data safety form in the Play Console must accurately reflect what the app collects and shares — this is now validated against the actual binary, inaccuracies get flagged

---

## React Native / Expo specific

Expo Managed Workflow apps go through Expo's build infrastructure, which adds its own surface:
- Secrets in `app.json` / `app.config.js` under `extra` are shipped in the app bundle — treat these like client-side secrets
- EAS Build environment variables marked as `secret` are truly server-side; only `public` EAS variables ship to the client
- OTA (over-the-air) updates via Expo can push JavaScript code changes without an app store review — this is a feature but also a supply-chain risk; confirm OTA update signing is enabled (`expo-updates` codesigning) so a compromised update server can't push arbitrary code

---

## Flutter specific

- The Dart VM debug port (`--observe`) must be disabled in production builds
- Flutter's `debugPrint` calls are stripped in release mode — confirm logging uses a production-appropriate logger (`logging` package or equivalent) rather than relying on release-mode stripping, since that behavior is an implementation detail
- Confirm `flutter build apk --release` / `flutter build ios --release` is what ships to app stores, not a profile or debug build
