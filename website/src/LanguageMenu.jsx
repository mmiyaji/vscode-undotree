import { useEffect, useId, useRef, useState } from "react";

const languages = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

export function LanguageMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const options = useRef([]);
  const listId = useId();
  const label = value === "ja" ? "表示言語" : "Display language";
  const selected = languages.findIndex((language) => language.value === value);

  useEffect(() => {
    if (open) options.current[focused]?.focus();
  }, [open, focused]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (index) => {
    onChange(languages[index].value);
    close();
  };
  const toggle = () => {
    setFocused(selected);
    setOpen((current) => !current);
  };

  return (
    <div
      className="language-control"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="language-trigger"
        type="button"
        ref={trigger}
        aria-label={`${label}: ${languages[selected].label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setFocused(selected);
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <i className="codicon codicon-globe" aria-hidden="true" />
        <span>{languages[selected].label}</span>
        <i
          className={`codicon codicon-chevron-${open ? "up" : "down"}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul
          className="language-menu"
          id={listId}
          role="listbox"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setFocused((current) =>
                (current + (event.key === "ArrowDown" ? 1 : -1) + languages.length) % languages.length,
              );
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              setFocused(event.key === "Home" ? 0 : languages.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              choose(focused);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          {languages.map((language, index) => (
            <li
              className="language-option"
              key={language.value}
              role="option"
              aria-selected={value === language.value}
              tabIndex={focused === index ? 0 : -1}
              ref={(element) => { options.current[index] = element; }}
              onFocus={() => setFocused(index)}
              onClick={() => choose(index)}
            >
              <span>{language.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
