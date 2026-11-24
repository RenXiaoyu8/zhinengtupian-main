import { useEffect, useRef } from 'react';
import './login.css';

const texture = new URL('./nebula.png', import.meta.url).href;

export function LoginCloud() {
  const hostRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const image = imageRef.current!;
    let active = true;
    let dispose: (() => void) | undefined;
    Promise.all([import('./cloudRenderer'), image.decode()])
      .then(([{ mountCloud }]) => {
        if (active) dispose = mountCloud(host, image);
      })
      .catch(() => { /* The still cloud also works without the animation renderer. */ });
    return () => {
      active = false;
      dispose?.();
    };
  }, []);

  return (
    <div className="login-cloud" ref={hostRef} aria-hidden="true">
      <img src={texture} ref={imageRef} alt="" />
    </div>
  );
}
