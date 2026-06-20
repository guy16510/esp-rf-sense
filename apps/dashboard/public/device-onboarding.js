const root = document.getElementById('app');
root.innerHTML = `
  <section class="hero">
    <div class="eyebrow">RF-SENSE GUIDED DEVICE SETUP</div>
    <h1>Connect, redirect, update, and validate all four ESP32 nodes</h1>
    <p>Changing the dashboard server IP is a configuration update. Installing new firmware is OTA. You do not need to flash firmware just because the server IP changed.</p>
    <div class="actions"><a class="button" href="/four-node-dashboard.html">Open control center</a><a class="button secondary" href="#redirect">Change server IP</a></div>
  </section>
  <nav class="steps"><a href="#first-boot">1. First boot</a><a href="#redirect">2. Server IP</a><a href="#ota">3. OTA</a><a href="#validate">4. Validate</a></nav>
  <section id="first-boot" class="card">
    <h2>1. First boot and Wi-Fi provisioning</h2>
    <ol class="check"><li>Power one ESP32 at a time.</li><li>Join its RF-Sense Wi-Fi network.</li><li>Open 192.168.4.1.</li><li>Enter Wi-Fi, collector IP, UDP port 5566, OTA manifest URL, and a unique node name.</li><li>Repeat for nodes A, B, C, and D.</li></ol>
  </section>
  <section id="redirect" class="card success">
    <h2>2. Change the collector server IP without reflashing</h2>
    <p>Run this once per node. The command saves the new target, reads it back, and only then reboots the device.</p>
    <pre>npm --workspace @rf-sense/cli run configure -- \\
  --host rf-sense-a1b2.local \\
  --collector-host 192.168.1.25 \\
  --collector-port 5566</pre>
  </section>
  <section id="ota" class="card">
    <h2>3. Check and apply OTA firmware</h2>
    <p>The firmware uses dual OTA slots, manifest validation, SHA-256 verification, boot self-validation, and rollback.</p>
    <pre>npm --workspace @rf-sense/cli run ota -- check --host rf-sense-a1b2.local
npm --workspace @rf-sense/cli run ota -- apply --host rf-sense-a1b2.local</pre>
  </section>
  <section id="validate" class="card warning">
    <h2>4. Validate before training</h2>
    <ul class="check"><li>Dashboard shows 4 / 4 ready.</li><li>Every node reports fresh frames and a non-zero CSI rate.</li><li>Collector target matches the dashboard server.</li><li>Firmware versions match across all four nodes.</li><li>Room dimensions and receiver placement are saved.</li><li>Record empty room, each trained location, and held-out validation runs.</li></ul>
    <p class="muted">Do not trust a moving XY dot until the validation gate passes. The coarse fallback is a trained-zone estimate, not continuous triangulation.</p>
  </section>`;
