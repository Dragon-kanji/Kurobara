import "@fontsource/bebas-neue/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";

const menuToggle =
  document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
const menu = document.querySelector<HTMLElement>("[data-menu]");

const closeMenu = () => {
  menuToggle?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-open");
};

menuToggle?.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  document.body.classList.toggle("menu-open", !isOpen);
});

menu?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    closeMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

const stageControls = document.querySelectorAll<HTMLButtonElement>(
  "[data-stage-control]"
);
const stages = document.querySelectorAll<HTMLElement>("[data-stage]");
const stageStatus = document.querySelector<HTMLElement>("[data-stage-status]");

for (const control of stageControls) {
  control.addEventListener("click", () => {
    const selectedStage = control.dataset.stageControl;
    if (!selectedStage) {
      return;
    }

    for (const candidate of stageControls) {
      const isSelected = candidate.dataset.stageControl === selectedStage;
      candidate.classList.toggle("is-active", isSelected);
      candidate.setAttribute("aria-pressed", String(isSelected));
    }

    for (const stage of stages) {
      stage.classList.toggle(
        "is-active",
        stage.dataset.stage === selectedStage
      );
    }

    if (stageStatus) {
      stageStatus.textContent = `${control.getAttribute("aria-label") ?? selectedStage} selected.`;
    }
  });
}

const copyButton = document.querySelector<HTMLButtonElement>(
  "[data-copy-command]"
);
const copyLabel = document.querySelector<HTMLElement>("[data-copy-label]");

copyButton?.addEventListener("click", async () => {
  const command = copyButton.dataset.copyText;
  if (!command) {
    return;
  }

  try {
    await navigator.clipboard.writeText(command);
    if (copyLabel) {
      copyLabel.textContent = "Copied";
    }
    window.setTimeout(() => {
      if (copyLabel) {
        copyLabel.textContent = "Copy commands";
      }
    }, 1800);
  } catch {
    if (copyLabel) {
      copyLabel.textContent = "Select commands above";
    }
  }
});

const revealTargets = document.querySelectorAll<HTMLElement>(".reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
  );

  for (const target of revealTargets) {
    observer.observe(target);
  }
} else {
  for (const target of revealTargets) {
    target.classList.add("is-visible");
  }
}

const year = document.querySelector<HTMLElement>("[data-year]");
if (year) {
  year.textContent = String(new Date().getFullYear());
}
