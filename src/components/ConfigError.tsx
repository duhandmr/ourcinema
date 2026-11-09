import type { ConfigProblem } from '../lib/env';
import { CenteredCard } from './CenteredCard';

const MESSAGES: Record<Exclude<ConfigProblem, null>, string> = {
  missing:
    'VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY ortam değişkenleri tanımlanmamış. Yerelde .env dosyasını, Vercel’de Project Settings > Environment Variables bölümünü doldurun.',
  'secret-key':
    'Güvenlik nedeniyle uygulama durduruldu: istemciye service_role / secret anahtarı verilmiş. Yalnızca anon (publishable) anahtarı kullanın ve sızan anahtarı Supabase panelinden yenileyin.',
  'bad-url': 'VITE_SUPABASE_URL https:// ile başlamalıdır.',
};

export function ConfigError({ problem }: { problem: Exclude<ConfigProblem, null> }) {
  return <CenteredCard title="Yapılandırma gerekli" description={MESSAGES[problem]} />;
}
