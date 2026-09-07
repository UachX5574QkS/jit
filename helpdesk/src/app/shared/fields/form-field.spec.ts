import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { FormFieldComponent } from './form-field';
import { fieldValidator, type FieldDefinition } from './field-types';

/**
 * Host that binds a FormFieldComponent to a reactive-form control, mirroring how
 * the New workflow wires it: the control carries {@link fieldValidator} and the
 * host feeds the resolved error message into the component's `errorMessage`
 * input.
 */
@Component({
  standalone: true,
  imports: [ReactiveFormsModule, FormFieldComponent],
  template: `
    <app-form-field
      [field]="field()"
      [formControl]="control"
      [errorMessage]="errorMessage()"
    />
  `,
})
class HostComponent {
  readonly field = signal<FieldDefinition>({
    id: 'f1',
    dataType: 'TEXT',
    label: 'Title',
    isMandatory: false,
  });
  control = new FormControl<unknown>('');
  readonly errorMessage = signal<string | null>(null);

  setField(field: FieldDefinition): void {
    this.field.set(field);
    this.control = new FormControl<unknown>('', { validators: fieldValidator(field) });
  }
}

function setup(field?: FieldDefinition) {
  const fixture = TestBed.createComponent(HostComponent);
  if (field) {
    fixture.componentInstance.setField(field);
  }
  fixture.detectChanges();
  return fixture;
}

describe('FormFieldComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
  });

  it('creates', () => {
    const fixture = setup();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the label uppercase/purple and a required asterisk when mandatory', () => {
    const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Summary', isMandatory: true });
    const el = fixture.nativeElement as HTMLElement;
    const label = el.querySelector('.field-label');
    expect(label?.textContent).toContain('Summary');
    expect(el.querySelector('.field-required')?.textContent).toBe('*');
  });

  it('does not render the required asterisk for an optional field', () => {
    const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Notes', isMandatory: false });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.field-required')).toBeNull();
  });

  describe('renders the type-appropriate control (R3.1, R2.7)', () => {
    const cases: Array<[FieldDefinition['dataType'], string]> = [
      ['TEXT', 'text'],
      ['EMAIL', 'email'],
      ['NUMERIC', 'number'],
      ['DATE', 'date'],
      ['DATETIME', 'datetime-local'],
      ['TIME', 'time'],
      ['REGEXP', 'text'],
    ];

    for (const [dataType, inputType] of cases) {
      it(`${dataType} → input[type=${inputType}]`, () => {
        const fixture = setup({ id: 'f', dataType, label: dataType, isMandatory: false });
        const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.field-control');
        expect(input).toBeTruthy();
        expect(input?.getAttribute('type')).toBe(inputType);
      });
    }

    it('BOOLEAN → checkbox', () => {
      const fixture = setup({ id: 'f', dataType: 'BOOLEAN', label: 'Flag', isMandatory: false });
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]');
      expect(input).toBeTruthy();
    });

    it('DROPDOWN → select with the resolved options (R3.5)', () => {
      const fixture = setup({
        id: 'f',
        dataType: 'DROPDOWN',
        label: 'Priority',
        isMandatory: false,
        options: ['Low', 'High'],
      });
      const el = fixture.nativeElement as HTMLElement;
      const select = el.querySelector('select.field-control');
      expect(select).toBeTruthy();
      const optionText = [...el.querySelectorAll('option')].map((o) => o.textContent?.trim());
      expect(optionText).toContain('Low');
      expect(optionText).toContain('High');
    });
  });

  describe('the "?" help affordance (R2.6)', () => {
    it('shows a "?" toggle when the field has help text and reveals it on click', () => {
      const fixture = setup({
        id: 'f',
        dataType: 'TEXT',
        label: 'Title',
        isMandatory: false,
        helpText: 'Enter a short summary',
      });
      const el = fixture.nativeElement as HTMLElement;
      const toggle = el.querySelector<HTMLButtonElement>('.help-toggle');
      expect(toggle).toBeTruthy();
      expect(el.querySelector('.field-help')).toBeNull();

      toggle!.click();
      fixture.detectChanges();
      expect(el.querySelector('.field-help')?.textContent).toContain('Enter a short summary');
      expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    });

    it('falls back to the description when there is no help text', () => {
      const fixture = setup({
        id: 'f',
        dataType: 'TEXT',
        label: 'Title',
        isMandatory: false,
        description: 'The request title',
      });
      const el = fixture.nativeElement as HTMLElement;
      el.querySelector<HTMLButtonElement>('.help-toggle')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.field-help')?.textContent).toContain('The request title');
    });

    it('offers no "?" when there is neither help text nor description', () => {
      const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Title', isMandatory: false });
      expect((fixture.nativeElement as HTMLElement).querySelector('.help-toggle')).toBeNull();
    });
  });

  describe('validation error display (R3, R3.6)', () => {
    it('shows the error only after the field is touched', () => {
      const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Title', isMandatory: true });
      fixture.componentInstance.errorMessage.set('Title is required');
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // Untouched → no error shown.
      expect(el.querySelector('.field-error')).toBeNull();

      const input = el.querySelector<HTMLInputElement>('input.field-control')!;
      input.dispatchEvent(new Event('blur'));
      fixture.detectChanges();
      expect(el.querySelector('.field-error')?.textContent).toContain('Title is required');
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
  });

  describe('ControlValueAccessor integration', () => {
    it('writes typed input back to the bound control', () => {
      const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Title', isMandatory: false });
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.field-control')!;
      input.value = 'Hello';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(fixture.componentInstance.control.value).toBe('Hello');
    });

    it('writes a real boolean from the checkbox', () => {
      const fixture = setup({ id: 'f', dataType: 'BOOLEAN', label: 'Flag', isMandatory: false });
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]')!;
      input.checked = true;
      input.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      expect(fixture.componentInstance.control.value).toBe(true);
    });

    it('reflects a value written from the form into the input', () => {
      const fixture = setup({ id: 'f', dataType: 'TEXT', label: 'Title', isMandatory: false });
      fixture.componentInstance.control.setValue('From form');
      fixture.detectChanges();
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.field-control')!;
      expect(input.value).toBe('From form');
    });
  });
});
