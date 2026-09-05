// Voxenite download page logic.
//
// 1. Loads channels/stable.json (the manifest that promote.py writes) and
//    picks the build for the visitor's OS.
// 2. Sums download_count over all release assets in the public releases repo
//    via the GitHub REST API to show a running download total.
//
// No build step, no framework. Everything is relative so the page works at
// https://<user>.github.io/<repo>/ as well as on a custom domain.

(function () {
  'use strict';

  // The public repository that hosts GitHub Releases (binaries) and Pages.
  // Keep in sync with RELEASES_REPO in .github/workflows/release.yml.
  const RELEASES_REPO = 'gharvhel/voxenite-releases';
  const RELEASES_URL = 'https://github.com/' + RELEASES_REPO + '/releases';
  const API_RELEASES = 'https://api.github.com/repos/' + RELEASES_REPO + '/releases?per_page=100';
  const COUNT_CACHE_KEY = 'voxenite.downloadCount';
  const COUNT_CACHE_TTL_MS = 10 * 60 * 1000;

  const KIND_LABEL = {
    installer: 'Installer (.exe)',
    dmg: 'Disk image (.dmg)',
    appimage: 'AppImage',
  };

  const PLATFORM_LABEL = {
    'windows-x64': 'Windows',
    'macos-universal': 'macOS',
    'linux-x64': 'Linux',
  };

  const $ = (id) => document.getElementById(id);
  const box = document.querySelector('.download-box');

  /// Detects the visitor's OS. Returns a platform key from PLATFORM_LABEL or
  /// null when unknown (mobile, unusual UA). Uses the modern UA-Client-Hints
  /// API when present, falls back to a userAgent regex otherwise.
  function detectPlatform() {
    const uaData = navigator.userAgentData;
    let os = uaData && uaData.platform ? uaData.platform : '';
    if (!os) {
      const ua = navigator.userAgent || '';
      if (/Windows/i.test(ua)) os = 'Windows';
      else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
      else if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) os = 'Linux';
    }
    os = os.toLowerCase();
    if (os.startsWith('win')) return 'windows-x64';
    if (os.startsWith('mac')) return 'macos-universal';
    if (os.startsWith('linux') || os.includes('bsd')) return 'linux-x64';
    return null;
  }

  function formatBytes(n) {
    if (!n || n <= 0) return '';
    const mb = n / (1024 * 1024);
    return mb >= 100 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB';
  }

  function formatCount(n) {
    return new Intl.NumberFormat(undefined).format(n);
  }

  function setUnavailable(reason) {
    box.dataset.state = 'unavailable';
    $('download-label').textContent = 'Download not available yet';
    $('download-sub').textContent = '';
    $('download-btn').removeAttribute('href');
    $('version-line').textContent = reason || 'No public release yet';
    $('not-yet').hidden = false;
    $('other-platforms').hidden = true;
  }

  /// Fills the primary button from the manifest for `platform`, and wires the
  /// secondary per-platform links. Assets missing from the manifest are hidden.
  function applyManifest(manifest) {
    const platforms = (manifest && manifest.platforms) || {};
    const available = Object.keys(platforms).filter((k) => platforms[k] && platforms[k].url);

    if (!manifest || !manifest.version || available.length === 0) {
      setUnavailable();
      return;
    }

    $('version-line').textContent = 'Version ' + manifest.version +
      (manifest.released ? ' · ' + new Date(manifest.released).toLocaleDateString() : '');

    const detected = detectPlatform();
    const primary = detected && platforms[detected] && platforms[detected].url ? detected : null;

    // Secondary links: always list every available build.
    document.querySelectorAll('#other-platforms a[data-platform]').forEach((a) => {
      const key = a.dataset.platform;
      const entry = platforms[key];
      if (!entry || !entry.url) { a.hidden = true; return; }
      a.href = entry.url;
      a.hidden = false;
      a.setAttribute('aria-current', key === primary ? 'true' : 'false');
      a.title = PLATFORM_LABEL[key] + (entry.size ? ' · ' + formatBytes(entry.size) : '');
    });

    if (primary) {
      const entry = platforms[primary];
      $('download-btn').href = entry.url;
      $('download-label').textContent = 'Download for ' + PLATFORM_LABEL[primary];
      $('download-sub').textContent = [manifest.version, formatBytes(entry.size), KIND_LABEL[entry.kind] || '']
        .filter(Boolean).join(' · ');
      box.dataset.state = 'ready';
    } else {
      // Unknown OS (phone, tablet, etc.): point the button at the platform list.
      $('download-btn').href = '#other-platforms';
      $('download-label').textContent = 'Choose your platform';
      $('download-sub').textContent = manifest.version;
      box.dataset.state = 'ready';
    }

    if (manifest.notes_url) {
      $('releases-link').href = manifest.notes_url;
    }
  }

  /// Sums asset download counts across all releases in RELEASES_REPO.
  /// Cached in localStorage for COUNT_CACHE_TTL_MS so a busy page does not
  /// burn the 60 requests/hour anonymous API limit.
  async function loadDownloadCount() {
    const el = $('download-count');
    try {
      const cached = JSON.parse(localStorage.getItem(COUNT_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.at < COUNT_CACHE_TTL_MS) {
        el.textContent = formatCount(cached.count) + ' downloads';
        return;
      }
    } catch (_) { /* storage unavailable, fall through */ }

    try {
      const res = await fetch(API_RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const releases = await res.json();
      let count = 0;
      for (const rel of releases) {
        for (const asset of rel.assets || []) count += asset.download_count || 0;
      }
      el.textContent = formatCount(count) + ' downloads';
      try { localStorage.setItem(COUNT_CACHE_KEY, JSON.stringify({ at: Date.now(), count })); } catch (_) {}
    } catch (err) {
      // Rate-limited or repo not public yet. Show stale cache if we have one.
      try {
        const cached = JSON.parse(localStorage.getItem(COUNT_CACHE_KEY) || 'null');
        if (cached) { el.textContent = formatCount(cached.count) + ' downloads'; return; }
      } catch (_) {}
      el.textContent = '';
    }
  }

  async function loadManifest() {
    try {
      const res = await fetch('channels/stable.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyManifest(await res.json());
    } catch (err) {
      setUnavailable('Could not load release information');
    }
  }

  $('releases-link').href = RELEASES_URL;
  loadManifest();
  loadDownloadCount();
})();
