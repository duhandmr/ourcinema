/**
 * İstemci ile sunucu saati arasındaki farkı ölçer; tüm zaman damgaları
 * sunucu saatine göre üretilir, böylece cihaz saatleri farklı olsa da
 * gecikme telafisi doğru hesaplanır.
 */
export class ServerClock {
  private offsetMs = 0;

  async calibrate(fetchServerTime: () => Promise<number>, samples = 3): Promise<void> {
    let bestRtt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < samples; i += 1) {
      const t0 = Date.now();
      try {
        const serverMs = await fetchServerTime();
        const t1 = Date.now();
        const rtt = t1 - t0;
        if (rtt < bestRtt && Number.isFinite(serverMs)) {
          bestRtt = rtt;
          this.offsetMs = serverMs - (t0 + t1) / 2;
        }
      } catch {
        // ölçüm başarısız: önceki değer korunur
      }
    }
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }
}
