import {
  APPLE_GATEKEEPER_HELP_URL,
  DOWNLOADS,
  DOCS_INSTALL_URL,
  DOCS_SELF_HOST_URL,
  GAJAE_CODE_URL,
  ISSUES_URL,
  LICENSE_URL,
  PRODUCT_NAME,
  RELEASE,
  RELEASES_URL,
  REPOSITORY_URL,
} from './releases.js';

function appleIcon() {
  return `<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`;
}

function faqItem(question, answer) {
  return `
    <details class="faq">
      <summary>
        <span class="faq-mark faq-plus">+</span>
        <span class="faq-mark faq-minus">−</span>
        ${question}
      </summary>
      <p>${answer}</p>
    </details>
  `;
}

export function renderLandingPage() {
  return `
    <div class="page-shell">
      <header class="site-header">
        <a class="brand" href="#top">
          <img src="./icon-96.png" alt="" width="24" height="24" />
          <span>Gajae</span>
        </a>
        <nav class="nav" aria-label="Primary">
          <a href="#features">Product</a>
          <a href="#download">Download</a>
          <a href="${DOCS_SELF_HOST_URL}">Docs</a>
          <a href="${RELEASES_URL}">Changelog</a>
          <a href="${REPOSITORY_URL}">GitHub</a>
        </nav>
      </header>

      <main>
        <section class="hero" id="top">
          <p class="eyebrow">Public beta · v${RELEASE.version}</p>
          <h1>The desktop app<br />for Gajae Code.</h1>
          <p class="lede">
            Open projects, resume sessions, and review changes—all in one local workspace.
          </p>
          <div class="cta-row">
            <div class="platform-cta">
              <a class="button button-primary" href="${DOWNLOADS.macosArm64.href}" aria-describedby="macos-beta-notice">
                ${appleIcon()}
                Download for macOS
              </a>
              <p class="platform-note" id="macos-beta-notice">Apple Silicon · macOS 13+ · Notarized by Apple</p>
            </div>
          </div>
          <div class="hero-links">
            <a class="quiet-link" href="${GAJAE_CODE_URL}">About Gajae Code</a>
            <a class="quiet-link" href="${REPOSITORY_URL}">Source code</a>
            <a class="quiet-link" href="#self-host">Server setup</a>
          </div>
        </section>

        <section class="product-overview" id="features" aria-label="Gajae Code App session and review">
          <img src="./screenshots/session-review.jpg" alt="A two-turn Gajae Code App session that writes greet.py and adds a --shout flag, with the Changes tab open on the diff and a review comment waiting to be sent" width="2880" height="1800" fetchpriority="high" />
          <div class="product-overview-copy">
            <p class="eyebrow">Real session · v${RELEASE.version}</p>
            <h2>Watch the work happen, then review it.</h2>
            <p>Each turn's tool calls fold into one block. The Changes tab shows the working tree as a diff, and a comment on a line becomes the next message.</p>
          </div>
        </section>

        <section class="details" id="workflow" aria-label="Product details">
          <article class="detail">
            <div class="detail-copy">
              <p class="eyebrow">Permissions</p>
              <h2>Commands wait for you.</h2>
              <p>By default a shell command stops the turn on a card: allow it once, always for this project, or deny it. The turn resumes where it paused.</p>
            </div>
            <img src="./screenshots/permission-card.jpg" alt="A Gajae Code App turn paused on a permission card for python3 hello.py, with Deny, Always deny, Always allow and Allow buttons" width="2880" height="1800" loading="lazy" />
          </article>
          <article class="detail">
            <div class="detail-copy">
              <p class="eyebrow">Session controls</p>
              <h2>Match the model to the task.</h2>
              <p>Pick the provider, the model and the reasoning depth for the next turn without leaving the session. A model chosen for a session stays with it.</p>
            </div>
            <img src="./screenshots/model-picker.jpg" alt="The model and reasoning picker open above a session, with ChatGPT selected, GPT-5.6 Terra chosen and the reasoning column beside it" width="2880" height="1800" loading="lazy" />
          </article>
        </section>

        <section class="download-section" id="download">
          <div class="section-copy">
            <p class="eyebrow">v${RELEASE.version}</p>
            <h2>Download the desktop app</h2>
            <p>Versioned files from GitHub Releases. Each download has its own SHA-256 checksum.</p>
          </div>
          <div class="download-list">
            <div class="download-row">
              <div>
                <h3>macOS</h3>
                <p>Apple Silicon · macOS 13+</p>
                <a class="quiet-link" href="#macos-install">First-launch instructions</a>
              </div>
              <div class="download-actions">
                <a class="text-button" href="${DOWNLOADS.macosArm64.href}">Download DMG</a>
                <a class="quiet-link" href="${DOWNLOADS.macosArm64.checksumHref}" aria-label="SHA-256 for macOS DMG">SHA-256</a>
              </div>
            </div>
          </div>
          <p class="availability">Intel Mac and Windows builds are not available yet.</p>
        </section>

        <section class="self-host-section" id="self-host">
          <div class="section-copy">
            <h2>Prefer the web interface?</h2>
            <p>Run Gajae Code App in your browser with the server archive or from source. These are alternatives to the desktop app.</p>
          </div>
          <div class="download-list">
            <div class="download-row">
              <div>
                <h3>Linux server</h3>
                <p>x86_64 · glibc 2.35+ · Requires Node.js 22.22.2+ (22.x)</p>
                <a class="quiet-link" href="${DOCS_SELF_HOST_URL}">Server installation guide</a>
              </div>
              <div class="download-actions">
                <a class="text-button" href="${DOWNLOADS.linuxServer.href}">Download archive</a>
                <a class="quiet-link" href="${DOWNLOADS.linuxServer.checksumHref}" aria-label="SHA-256 for Linux server archive">SHA-256</a>
              </div>
            </div>
            <div class="download-row">
              <div>
                <h3>Source</h3>
                <p>Run the web interface locally.</p>
              </div>
              <div class="download-actions">
                <a class="text-button" href="${REPOSITORY_URL}">View on GitHub</a>
              </div>
            </div>
          </div>
        </section>

        <section class="install-section" id="macos-install">
          <div class="section-copy">
            <p class="eyebrow">Current macOS beta</p>
            <h2>Opening the app for the first time</h2>
            <p>
              Since v2.0.0-beta.7 the DMG is signed with a Developer ID and
              notarized by Apple, so macOS opens it like any other app. Verify the
              download anyway; the checksum is published beside it.
            </p>
          </div>
          <div class="install-layout">
            <ol class="install-steps">
              <li><span>1</span><p>Download the DMG and its SHA-256 file.</p></li>
              <li><span>2</span><p>Open the DMG and drag Gajae Code App to Applications.</p></li>
              <li><span>3</span><p>Open the app. Gatekeeper checks the notarization ticket and lets it run.</p></li>
              <li><span>4</span><p>Only a build older than beta.7 needs <strong>System Settings → Privacy &amp; Security</strong> → <strong>Open Anyway</strong>.</p></li>
            </ol>
            <div class="verify-block">
              <p>Verify in Terminal</p>
              <pre><code>cd ~/Downloads
${DOWNLOADS.macosArm64.verifyCommand}</code></pre>
              <a class="quiet-link" href="${APPLE_GATEKEEPER_HELP_URL}">Apple's Gatekeeper instructions ↗</a>
            </div>
          </div>
        </section>

        <section class="faq-section" id="faq">
          <div class="section-copy">
            <h2>FAQ</h2>
          </div>
          <div class="faq-list">
            ${faqItem(
              'Is it free?',
              'Yes. Gajae Code App is open source under the MIT license. It does not include a model or subscription.',
            )}
            ${faqItem(
              'Where does it run?',
              'The desktop app and web UI run on your machine. Project files and execution state stay on the host.',
            )}
            ${faqItem(
              'What does it support?',
              'Gajae Code. The app uses the models, presets, skills, and credentials configured in your Gajae installation.',
            )}
            ${faqItem(
              'Do I need the desktop app?',
              `No. You can run the web UI from source or use the Linux server archive. See <a href="${DOCS_INSTALL_URL}">the install guide</a>.`,
            )}
          </div>
        </section>
      </main>

      <footer class="site-footer">
        <div class="footer-brand">
          <img src="./icon-96.png" alt="" width="22" height="22" />
          <span>${PRODUCT_NAME}</span>
        </div>
        <nav class="footer-links" aria-label="Footer">
          <a href="${GAJAE_CODE_URL}">Gajae Code</a>
          <a href="${LICENSE_URL}">License</a>
          <a href="${ISSUES_URL}">Issues</a>
          <a href="${REPOSITORY_URL}">GitHub</a>
        </nav>
      </footer>
    </div>
  `;
}
