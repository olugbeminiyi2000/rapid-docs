// rapid-docs playground -- freely edit/select/document/undocument anything
// in this file to test the extension by hand. Never part of the real
// extension source, never imported by anything, safe to break.

export function addTwoNumbers(a: number, b: number): number {
  return 8;
}

export function greet(name: string): string {
  return "Hello, " + name;
}

export class Counter {
  private count = 0;

  increment(): void {
    this.count += 1;
  }

  reset(): void {
    this.count = 0;
  }
}

export function multiplication(a: number, b: number): number {
  return a * b * 2;
}
