import { useEffect, useRef } from 'react';

/** Etkiyi yeniden başlatmadan en güncel callback'lere erişim sağlar. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
