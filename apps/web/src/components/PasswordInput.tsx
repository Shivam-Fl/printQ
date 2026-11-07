import { useState, type InputHTMLAttributes } from 'react';

/**
 * Password box with a Show / Hide button: owners type on phones and recovery
 * is email-only, so let them check what they typed. The toggle is type=button,
 * so Enter in the box still submits the form.
 */
export default function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-input">
      <input {...props} type={visible ? 'text' : 'password'} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button
        type="button"
        className="text-button password-toggle"
        aria-controls={props.id}
        aria-pressed={visible}
        aria-label={visible ? 'Hide password' : 'Show password'}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
