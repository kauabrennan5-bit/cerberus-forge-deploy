import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Pause, Play, RotateCcw } from 'lucide-react';
import type { Mesh, Object3D, Texture } from 'three';
import type { OrbitControls as OrbitControlsInstance } from 'three/examples/jsm/controls/OrbitControls.js';

const NEXBOT_MODEL_URL = '/assets/3d/nexbot_robot_character_concept.glb';

type ViewerStatus = 'loading' | 'ready' | 'error' | 'unsupported';

interface NexbotHeroProps {
  onEnterCatalog: () => void;
}

const supportsWebGL = () => {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext
      && (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    return false;
  }
};

export function NexbotHero({ onEnterCatalog }: NexbotHeroProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [progress, setProgress] = useState(0);
  const [isRotationPaused, setIsRotationPaused] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const controlsRef = useRef<OrbitControlsInstance | null>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);
  const hoveredRef = useRef(false);
  const manuallyPausedRef = useRef(false);
  const reducedMotionRef = useRef(false);

  const syncAutoRotation = () => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotate = !manuallyPausedRef.current && !hoveredRef.current && !reducedMotionRef.current;
  };

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotionPreference = () => {
      reducedMotionRef.current = query.matches;
      setPrefersReducedMotion(query.matches);
      syncAutoRotation();
    };

    updateMotionPreference();
    query.addEventListener?.('change', updateMotionPreference);
    return () => query.removeEventListener?.('change', updateMotionPreference);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    if (!supportsWebGL()) {
      setStatus('unsupported');
      return;
    }

    let importCancelled = false;
    let teardownViewer: (() => void) | null = null;

    const initializeViewer = async () => {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ]);
      if (importCancelled) return;

    let disposed = false;
    let frameId = 0;
    let isVisible = true;
    let isPageVisible = document.visibilityState === 'visible';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-label', 'NEXBOT, guardião 3D interativo da Cerberus Finds');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('tabindex', '0');
    renderer.domElement.style.touchAction = 'pan-y';
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.65;
    controls.autoRotate = !reducedMotionRef.current;
    controls.autoRotateSpeed = 0.48;
    controls.minPolarAngle = Math.PI * 0.34;
    controls.maxPolarAngle = Math.PI * 0.66;
    controlsRef.current = controls;

    const ambientLight = new THREE.HemisphereLight(0xd9e8ff, 0x160d08, 1.45);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xf0b45e, 5.6);
    keyLight.position.set(4, 6, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.00025;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x6f8fbf, 3.2);
    rimLight.position.set(-5, 3, -4);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0x8a1f1f, 2.4, 20, 2);
    fillLight.position.set(0, -1, 4);
    scene.add(fillLight);

    let modelRoot: Object3D | null = null;
    let floor: Mesh | null = null;
    let fittedDistance = 8;
    const loader = new GLTFLoader();

    const fitCamera = () => {
      if (!modelRoot) return;
      const bounds = new THREE.Box3().setFromObject(modelRoot);
      const size = bounds.getSize(new THREE.Vector3());
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));
      const verticalDistance = size.y / (2 * Math.tan(verticalFov / 2));
      const horizontalDistance = size.x / (2 * Math.tan(horizontalFov / 2));
      fittedDistance = Math.max(verticalDistance, horizontalDistance) * 1.18;

      camera.near = Math.max(0.01, fittedDistance / 100);
      camera.far = fittedDistance * 25;
      camera.position.set(size.x * 0.16, size.y * 0.035, fittedDistance);
      camera.updateProjectionMatrix();
      controls.target.set(0, size.y * 0.025, 0);
      controls.minDistance = fittedDistance * 0.74;
      controls.maxDistance = fittedDistance * 1.35;
      controls.update();

      resetCameraRef.current = () => {
        camera.position.set(size.x * 0.16, size.y * 0.035, fittedDistance);
        controls.target.set(0, size.y * 0.025, 0);
        controls.update();
      };
    };

    loader.load(
      NEXBOT_MODEL_URL,
      (gltf) => {
        if (disposed) return;
        modelRoot = gltf.scene;
        const initialBounds = new THREE.Box3().setFromObject(modelRoot);
        const center = initialBounds.getCenter(new THREE.Vector3());
        const size = initialBounds.getSize(new THREE.Vector3());
        modelRoot.position.sub(center);
        modelRoot.rotation.y = THREE.MathUtils.degToRad(-8);

        modelRoot.traverse((child) => {
          if (child instanceof THREE.Light) {
            child.visible = false;
            return;
          }
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = true;
          child.receiveShadow = true;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) {
            if ('envMapIntensity' in material) material.envMapIntensity = 1.15;
            if (material instanceof THREE.MeshStandardMaterial) {
              material.color.setHex(0x918f89);
              material.metalness = 0.54;
              material.roughness = 0.46;
              material.needsUpdate = true;
            }
          }
        });

        floor = new THREE.Mesh(
          new THREE.CircleGeometry(Math.max(size.x, size.z) * 0.62, 64),
          new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42 }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -size.y / 2 - size.y * 0.006;
        floor.receiveShadow = true;

        scene.add(modelRoot);
        scene.add(floor);
        fitCamera();
        setProgress(100);
        setStatus('ready');
      },
      (event) => {
        if (disposed || !event.total) return;
        setProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      },
      (error) => {
        console.error('Falha ao carregar o NEXBOT:', error);
        if (!disposed) setStatus('error');
      },
    );

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const isCompact = width < 720;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCompact ? 1.25 : 1.6));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (modelRoot) fitCamera();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { rootMargin: '120px' },
    );
    intersectionObserver.observe(mount);

    const handleVisibilityChange = () => {
      isPageVisible = document.visibilityState === 'visible';
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      if (!isVisible || !isPageVisible) return;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    teardownViewer = () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      controls.dispose();
      controlsRef.current = null;
      resetCameraRef.current = null;

      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            const possibleTexture = value as Texture | undefined;
            if (possibleTexture?.isTexture) possibleTexture.dispose();
          }
          material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    };

    void initializeViewer().catch((error) => {
      console.error('Falha ao inicializar o visualizador NEXBOT:', error);
      if (!importCancelled) setStatus('error');
    });

    return () => {
      importCancelled = true;
      teardownViewer?.();
    };
  }, []);

  const toggleRotation = () => {
    manuallyPausedRef.current = !manuallyPausedRef.current;
    setIsRotationPaused(manuallyPausedRef.current);
    syncAutoRotation();
  };

  const handlePointerEnter = () => {
    hoveredRef.current = true;
    syncAutoRotation();
  };

  const handlePointerLeave = () => {
    hoveredRef.current = false;
    syncAutoRotation();
  };

  return (
    <section className="nexbot-hero" aria-labelledby="nexbot-hero-title">
      <div className="nexbot-hero__grid" aria-hidden="true" />
      <div className="nexbot-hero__model-column">
        <div
          className="nexbot-hero__stage"
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <div ref={mountRef} className="nexbot-hero__canvas" />

          {status === 'loading' && (
            <div className="nexbot-hero__loading" role="status" aria-live="polite">
              <span className="nexbot-hero__loading-dot" />
              <span>Inicializando guardião{progress > 0 ? ` · ${progress}%` : ''}</span>
            </div>
          )}

          {(status === 'error' || status === 'unsupported') && (
            <div className="nexbot-hero__fallback" role="status">
              <span className="nexbot-hero__fallback-mark">III</span>
              <p>
                {status === 'unsupported'
                  ? 'A experiência 3D não é compatível com este navegador.'
                  : 'O guardião 3D não pôde ser carregado agora.'}
              </p>
              <span>O acervo continua disponível abaixo.</span>
            </div>
          )}

          {status === 'ready' && (
            <div className="nexbot-hero__controls" aria-label="Controles do modelo 3D">
              {!prefersReducedMotion && (
                <button type="button" onClick={toggleRotation} aria-pressed={isRotationPaused}>
                  {isRotationPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  <span>{isRotationPaused ? 'Retomar' : 'Pausar'}</span>
                </button>
              )}
              <button type="button" onClick={() => resetCameraRef.current?.()}>
                <RotateCcw aria-hidden="true" />
                <span>Reposicionar</span>
              </button>
            </div>
          )}

          <p className="nexbot-hero__interaction-hint">Arraste para girar · toque com dois dedos para aproximar</p>
        </div>
      </div>

      <div className="nexbot-hero__copy">
        <div className="nexbot-hero__eyebrow">
          <span aria-hidden="true" />
          <p>Cerberus Finds</p>
        </div>
        <h1 id="nexbot-hero-title">Curadoria para quem não quer encontrar o óbvio.</h1>
        <p className="nexbot-hero__description">
          Uma seleção de objetos, peças e descobertas escolhidas por estética, personalidade e utilidade.
        </p>
        <button type="button" className="nexbot-hero__cta" onClick={onEnterCatalog}>
          <span>Entrar na curadoria</span>
          <ArrowDown aria-hidden="true" />
        </button>
        <div className="nexbot-hero__meta">
          <span>Scroll to discover</span>
          <span aria-hidden="true" className="nexbot-hero__meta-line" />
          <span>Objeto 3D interativo</span>
        </div>
      </div>

      <p className="nexbot-hero__credit">
        3D asset: NEXBOT — robot character concept, jules.sore13, CC BY 4.0.
      </p>
    </section>
  );
}
