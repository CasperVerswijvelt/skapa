import plusIcon from "./plus.svg?raw";
import minusIcon from "./minus.svg?raw";

export const rangeControl = (
  id: string,
  opts: {
    name: string;
    min: string;
    max: string;
    sliderMin: string;
    sliderMax: string;
    unit?: string;
  },
): {
  wrapper: HTMLElement;
  range: HTMLInputElement;
  input: HTMLInputElement;
} => {
  const range = (
    <input
      type="range"
      id={`${id}-range`}
      min={opts.min}
      max={opts.max}
      aria-label={`${opts.name} slider`}
    />
  ) as HTMLInputElement;

  const input = (
    <input
      type="number"
      id={id}
      name={id}
      min={opts.sliderMin}
      max={opts.sliderMax}
      aria-label={opts.name}
    />
  ) as HTMLInputElement;

  const valueDiv = (<div className="range-input-value">{input}</div>) as HTMLDivElement;
  if (opts.unit) valueDiv.dataset.unit = opts.unit;

  const wrapper = (
    <div className="range-input-wrapper">
      <label htmlFor={id}>{opts.name}</label>
      {range}
      {valueDiv}
    </div>
  );

  return { wrapper, range, input };
};

export const toggleControl = (
  id: string,
  opts: { label: string },
): {
  wrapper: HTMLElement;
  input: HTMLInputElement;
} => {
  const input = (
    <input type="checkbox" id={id} className="toggle-switch" />
  ) as HTMLInputElement;

  const wrapper = (
    <div className="toggle-input-wrapper">
      <label htmlFor={id}>{opts.label}</label>
      {input}
    </div>
  );

  return { wrapper, input };
};

export const advancedSettings = (
  id: string,
): {
  wrapper: HTMLElement;
  button: HTMLButtonElement;
  content: HTMLDivElement;
} => {
  const button = (
    <button type="button" id={`${id}-toggle`} className="advanced-settings-toggle">
      Show advanced settings
    </button>
  ) as HTMLButtonElement;

  const content = (
    <div className="advanced-settings-content" style="display: none;"></div>
  ) as HTMLDivElement;

  const wrapper = (
    <div className="advanced-settings">
      {button}
      {content}
    </div>
  );

  return { wrapper, button, content };
};

export const stepper = (
  id: string,
  opts: { min: string; max: string; label: string },
) => (
  <div className="stepper-input-wrapper">
    <label htmlFor={id}>{opts.label}</label>
    <button
      type="button"
      id={`${id}-minus`}
      innerHTML={minusIcon}
      aria-label="Remove level"
    ></button>
    <div className="stepper-input-value">
      <input type="number" id={id} name={id} min={opts.min} max={opts.max} />
    </div>
    <button
      type="button"
      id={`${id}-plus`}
      innerHTML={plusIcon}
      aria-label="Add level"
    ></button>
  </div>
);
