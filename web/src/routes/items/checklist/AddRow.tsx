import { useId } from 'react';
import { Button } from '../../../components/kit';

/**
 * One input with an *Add* button at the end of a checklist section; Enter
 * adds (UI_SPEC §6.3.1 "Add rows").
 */
export function AddRow({
  label,
  placeholder,
  onAdd,
}: {
  label: string;
  placeholder: string;
  onAdd: (text: string) => void;
}) {
  const id = useId();
  return (
    <form
      className="addrow"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('text') as HTMLInputElement;
        const text = input.value.trim();
        if (!text) return;
        onAdd(text);
        input.value = '';
      }}
    >
      <label className="sr" htmlFor={id}>
        {label}
      </label>
      <input id={id} name="text" className="input" placeholder={placeholder} autoComplete="off" />
      <Button type="submit" size="sm">
        Add
      </Button>
    </form>
  );
}
