/// Outward-facing addresses the app links to: support contact, store listing,
/// and the hosted legal pages.
///
/// These are deliberately in one file because App Store review checks all of
/// them, and because two of them cannot be filled in until after the first
/// submission (see [kAppStoreId]).
library;

/// Support address shown to users and filed as the App Store support contact.
///
/// Must not be a personal or institutional address — review flags those.
const String kSupportEmail = 'support@example.com';

/// Numeric App Store ID, assigned by Apple **after** the first build is
/// submitted. Empty until then, which is what [hasStoreListing] keys off.
const String kAppStoreId = '';

/// Play Store application id. Still the Flutter template default in
/// `android/app/build.gradle.kts`; Android is not shipping for v1.
const String kAndroidPackageName = 'com.example.cleaning';

/// Publicly hosted privacy policy. App Store Connect requires a reachable URL;
/// the in-app policy text alone does not satisfy review.
const String kPrivacyPolicyUrl =
    'https://keanooo7.github.io/squeeeks-legal/privacy.html';

/// Publicly hosted terms of service. Required alongside the privacy policy
/// because the app sells auto-renewing subscriptions.
const String kTermsOfServiceUrl =
    'https://keanooo7.github.io/squeeeks-legal/terms.html';

/// Whether a public store listing exists yet. Guards the "Rate the App" entry —
/// linking to an unassigned ID opens a dead page, which review does flag.
bool get hasStoreListing => kAppStoreId.isNotEmpty;
