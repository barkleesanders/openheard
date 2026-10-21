import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";

function isControl(child: ReactNode): child is ReactElement<{ id?: string }> {
  return (
    isValidElement(child) && typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type)
  );
}

export function LabeledInput({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  className: string;
}) {
  const generatedId = useId();
  const content = Children.toArray(children);
  const controls = content.filter(isControl);
  const control = controls[0];
  if (controls.length !== 1 || !control) throw new Error("LabeledInput requires exactly one form control");
  const inputId = control.props.id || generatedId;
  return (
    <label htmlFor={inputId} className={className}>
      <span className="sr-only">{label}</span>
      {icon}
      {content.map((child) => (child === control ? cloneElement(control, { id: inputId }) : child))}
    </label>
  );
}
