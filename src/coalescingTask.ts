export class CoalescingTask {
  private active: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  public run(task: () => Promise<void>): Promise<void> {
    if (!this.active) {
      return this.start(task);
    }
    this.queued ??= this.active
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined;
        return this.start(task);
      });
    return this.queued;
  }

  private start(task: () => Promise<void>): Promise<void> {
    const active = Promise.resolve().then(task);
    this.active = active;
    void active.finally(() => {
      if (this.active === active) {
        this.active = undefined;
      }
    }).catch(() => undefined);
    return active;
  }
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
