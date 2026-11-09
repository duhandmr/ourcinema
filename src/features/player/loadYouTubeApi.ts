let pending: Promise<typeof YT> | null = null;

/** YouTube IFrame API betiğini bir kez yükler. */
export function loadYouTubeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (pending) return pending;

  pending = new Promise<typeof YT>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const timeout = window.setTimeout(() => {
      pending = null;
      reject(new Error('YouTube oynatıcısı zamanında yüklenemedi. Bağlantınızı kontrol edin.'));
    }, 15000);

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      previous?.();
      if (window.YT) resolve(window.YT);
      else reject(new Error('YouTube oynatıcısı yüklenemedi.'));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timeout);
      pending = null;
      script.remove();
      reject(new Error('YouTube oynatıcısı yüklenemedi. Bir içerik engelleyici bunu engelliyor olabilir.'));
    };
    document.head.appendChild(script);
  });

  return pending;
}
