export interface ResponsiveCollabTarget {
  readonly prepare?: () => Promise<void>;
  readonly reveal: () => Promise<void>;
  readonly select: () => boolean;
}

export interface ResponsiveCollabRouterOptions {
  readonly createMainTabTarget: () => Promise<ResponsiveCollabTarget | null>;
  readonly listExistingTargets: () => readonly ResponsiveCollabTarget[];
}

export class ResponsiveCollabRouter {
  constructor(private readonly options: ResponsiveCollabRouterOptions) {}

  async open(): Promise<boolean> {
    for (const target of this.options.listExistingTargets()) {
      if (await this.selectAndReveal(target, false)) return true;
    }
    const fallback = await this.options.createMainTabTarget().catch(() => null);
    return fallback ? this.selectAndReveal(fallback, true) : false;
  }

  private async selectAndReveal(
    target: ResponsiveCollabTarget,
    prepare: boolean,
  ): Promise<boolean> {
    try {
      if (prepare) await target.prepare?.();
      if (!target.select()) return false;
      await target.reveal();
      return true;
    } catch {
      return false;
    }
  }
}
