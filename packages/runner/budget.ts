/** Integer accounting units, reserved synchronously before any async dispatch. */
export class Budget {
  readonly limit: number;
  private reservations = new Map<string, number>();
  private spent = 0;
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid budget');
    this.limit = limit;
  }
  get reserved(): number { return [...this.reservations.values()].reduce((sum, n) => sum + n, 0); }
  reserve(id: string, amount: number): boolean {
    if (!id || this.reservations.has(id) || !Number.isSafeInteger(amount) || amount <= 0)
      throw new Error('Invalid reservation');
    if (amount > this.limit - this.spent - this.reserved) return false;
    this.reservations.set(id, amount);
    return true;
  }
  settle(id: string, actual: number): void {
    const reserved = this.reservations.get(id);
    if (reserved === undefined || !Number.isSafeInteger(actual) || actual < 0 || actual > reserved)
      throw new Error('Invalid settlement');
    this.reservations.delete(id);
    this.spent += actual;
  }
}
