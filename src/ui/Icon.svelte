<script lang="ts">
  const PATHS: Record<string, string> = {
    play: 'M7 4.5v15l12-7.5z',
    stop: 'M6 6h12v12H6z',
    undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
    share: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
    download: 'M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 19h16',
    midi: 'M4 6h16v12H4zM8 6v7M12 6v7M16 6v7',
    theme: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-1.5-1-1.5-1-3 0-1 1-2 2.5-2H18a3 3 0 0 0 3-3c0-4.5-4-8-9-8zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
    help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    x: 'M6 6l12 12M18 6 6 18',
    open: 'M3 7v11h18V9h-9l-2-2z',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    check: 'm5 12 5 5 9-10',
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    up: 'm6 15 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
    unlock: 'M7 11V8a5 5 0 0 1 9.5-2M5 11h14v9H5z',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    note: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    wave: 'M2 12h3l2-7 4 14 3-10 2 5 2-2h4',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4.5 4.5',
    metro: 'M9 3h6l4 18H5zM12 14l5-8M7.5 14h9',
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
    dice: 'M5 5h14v14H5zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01',
  };
  let { name, size = 16, fill = false }: { name: string; size?: number; fill?: boolean } = $props();
</script>

<svg viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>
