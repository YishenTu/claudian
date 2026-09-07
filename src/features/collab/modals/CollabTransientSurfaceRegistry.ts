export interface CollabTransientSurface {
  close(): void;
  open(): void;
}

export type CollabTransientSurfaceFactory = (
  onClosed: () => void,
) => CollabTransientSurface;

export class CollabTransientSurfaceRegistry {
  private readonly surfaces = new Set<CollabTransientSurface>();

  open(factory: CollabTransientSurfaceFactory): void {
    let surface: CollabTransientSurface | null = null;
    const onClosed = (): void => {
      if (surface) this.surfaces.delete(surface);
    };
    surface = factory(onClosed);
    this.surfaces.add(surface);
    try {
      surface.open();
    } catch (error) {
      this.surfaces.delete(surface);
      throw error;
    }
  }

  closeAll(): void {
    const surfaces = Array.from(this.surfaces);
    this.surfaces.clear();
    for (const surface of surfaces) surface.close();
  }
}
