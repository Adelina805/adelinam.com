const iconMap = [
  {
    matcher: /\bwebsite\b|\bdevpost\b|\bitch.io\b|\bproject\b|\bprototype\b/,
    iconId: "icon-live-link",
  },
  { matcher: /\bmockup\b|\bdesign\b/, iconId: "icon-mockup" },
  { matcher: /\brepository\b|\bcode\b/, iconId: "icon-repository" },
  {
    matcher: /\bcase\s*study\b|\bview\b|\bread\s*post\b|\b/,
    iconId: "icon-case-study",
  },
];

const embeddedSprite = `
  <symbol id="icon-live-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"></path>
  </symbol>
  <symbol id="icon-mockup" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path>
  </symbol>
  <symbol id="icon-repository" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="m16 18 6-6-6-6"></path>
    <path d="m8 6-6 6 6 6"></path>
  </symbol>
  <symbol id="icon-case-study" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path>
    <path d="M14 2v5a1 1 0 0 0 1 1h5"></path>
    <path d="M10 9H8"></path>
    <path d="M16 13H8"></path>
    <path d="M16 17H8"></path>
  </symbol>
`;

function ensureIconSprite() {
  if (document.getElementById("icon-sprite")) {
    return;
  }

  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sprite.id = "icon-sprite";
  sprite.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("focusable", "false");
  sprite.style.position = "absolute";
  sprite.style.width = "0";
  sprite.style.height = "0";
  sprite.style.overflow = "hidden";
  sprite.innerHTML = embeddedSprite;

  document.body.prepend(sprite);
}

function attachIcons() {
  for (const link of document.querySelectorAll(".project-links a")) {
    const label = link.textContent.trim().toLowerCase();
    const match = iconMap.find(({ matcher }) => matcher.test(label));

    if (!match || link.querySelector(".link-icon")) {
      continue;
    }

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "link-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");

    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${match.iconId}`);
    use.setAttributeNS(
      "http://www.w3.org/1999/xlink",
      "xlink:href",
      `#${match.iconId}`,
    );

    icon.appendChild(use);
    link.appendChild(icon);
  }
}

function setupRevealOnScroll() {
  const revealEls = document.querySelectorAll(".reveal-on-scroll");
  if (!revealEls.length) {
    return;
  }

  const elements = Array.from(revealEls);
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  // Keep content visible for crawlers and assistive tech. Only animate when
  // JS is running and the user has not requested reduced motion.
  if (prefersReducedMotion) {
    for (const el of elements) {
      el.classList.add("is-visible");
    }
    return;
  }

  for (const el of elements) {
    el.classList.add("reveal-pending");
    el.classList.remove("is-visible");
  }

  const show = (el) => {
    el.classList.add("is-visible");
    el.classList.remove("reveal-pending");

    // Safari blocks autoplay while opacity:0; kick muted looping videos once shown.
    for (const video of el.querySelectorAll(
      "video.featured-thumbnail, .experience-role-media video",
    )) {
      video.muted = true;
      video.playsInline = true;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }
  };

  // No IntersectionObserver: show all immediately (older browsers).
  if (!("IntersectionObserver" in window)) {
    for (const el of elements) show(el);
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        show(entry.target);
        obs.unobserve(entry.target);
      }
    },
    // Reveal as soon as a small part of the section is in view.
    { threshold: 0.01, rootMargin: "0px 0px -5% 0px" },
  );

  for (const el of elements) {
    observer.observe(el);
  }
}

// Handles body class, icon swap, and persistent label updates for both theme toggle buttons.
function setupThemeToggle() {
  const toggles = document.querySelectorAll(".theme-toggle");
  if (!toggles.length) {
    return;
  }

  const storageKey = "portfolio-theme";
  const shouldBlurOnTap =
    (typeof window.matchMedia === "function" &&
      (window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(hover: none)").matches)) ||
    "ontouchstart" in window;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const savedTheme = localStorage.getItem(storageKey);
  const initialDark = savedTheme ? savedTheme === "dark" : prefersDark;

  document.body.classList.toggle("dark", initialDark);
  updateThemeToggleLabels(initialDark, toggles);

  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      const nowDark = !document.body.classList.contains("dark");
      document.body.classList.toggle("dark", nowDark);
      localStorage.setItem(storageKey, nowDark ? "dark" : "light");
      updateThemeToggleLabels(nowDark, toggles);
      // Prevent touch browsers from keeping a "hover" styling state.
      if (shouldBlurOnTap) toggle.blur();
    });
  }
}

function updateThemeToggleLabels(isDark, toggles) {
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  for (const toggle of toggles) {
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
}

function scrollToPageTop(event) {
  event.preventDefault();

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });

  if (location.hash !== "#top") {
    history.pushState(null, "", "#top");
  }
}

// Home should reach the very top of the page, not the #about section offset.
// The sidebar name is a mobile-only shortcut to the same action.
function setupHomeNav() {
  const homeLink = document.querySelector('.sidebar-nav a[href="#top"]');
  const nameLink = document.querySelector(".sidebar-name");
  const mobileQuery = window.matchMedia("(max-width: 880px)");

  if (homeLink) {
    homeLink.addEventListener("click", scrollToPageTop);
  }

  if (!nameLink) {
    return;
  }

  const syncNameLink = () => {
    nameLink.tabIndex = mobileQuery.matches ? 0 : -1;
  };

  syncNameLink();

  nameLink.addEventListener("click", (event) => {
    if (!mobileQuery.matches) {
      event.preventDefault();
      return;
    }

    scrollToPageTop(event);
  });

  if (typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", syncNameLink);
  } else if (typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(syncNameLink);
  }
}

// Mobile sidebar opens off-canvas and closes on link click, backdrop, Escape, or resize.
function setupMobileMenu() {
  const menuToggle = document.querySelector(".menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.querySelector(".sidebar-backdrop");

  if (!menuToggle || !sidebar) {
    return;
  }

  const mobileQuery = window.matchMedia("(max-width: 880px)");
  const shouldBlurOnTap =
    (typeof window.matchMedia === "function" &&
      (window.matchMedia("(pointer: coarse)").matches ||
        window.matchMedia("(hover: none)").matches)) ||
    "ontouchstart" in window;

  const setOpen = (isOpen) => {
    sidebar.classList.toggle("is-open", isOpen);
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    menuToggle.setAttribute(
      "aria-label",
      isOpen ? "Close navigation menu" : "Open navigation menu",
    );
    menuToggle.setAttribute("title", isOpen ? "Close menu" : "Open menu");
    document.body.classList.toggle("sidebar-open", isOpen);

    if (backdrop) {
      backdrop.classList.toggle("is-visible", isOpen);
      backdrop.hidden = !isOpen;
      backdrop.setAttribute("aria-hidden", String(!isOpen));
    }
  };

  const closeMenu = () => setOpen(false);

  menuToggle.addEventListener("click", () => {
    const isOpen = !sidebar.classList.contains("is-open");
    setOpen(isOpen);
    if (shouldBlurOnTap) menuToggle.blur();
  });

  if (backdrop) {
    backdrop.addEventListener("click", closeMenu);
  }

  for (const link of sidebar.querySelectorAll(".sidebar-nav a, .sidebar-name")) {
    link.addEventListener("click", () => {
      if (mobileQuery.matches) {
        closeMenu();
        if (shouldBlurOnTap) menuToggle.blur();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
      closeMenu();
      menuToggle.focus();
    }
  });

  const handleViewportChange = () => {
    if (!mobileQuery.matches && sidebar.classList.contains("is-open")) {
      closeMenu();
    }
  };

  window.addEventListener("resize", handleViewportChange);
  if (typeof mobileQuery.addEventListener === "function") {
    mobileQuery.addEventListener("change", handleViewportChange);
  } else if (typeof mobileQuery.addListener === "function") {
    mobileQuery.addListener(handleViewportChange);
  }
}

// Highlight the sidebar link for the section currently in view.
function setupScrollSpy() {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) {
    return;
  }

  const items = Array.from(nav.querySelectorAll('a[href^="#"]'))
    .map((link) => {
      const id = decodeURIComponent(link.hash.slice(1));
      const target = document.getElementById(id);
      return target ? { link, target } : null;
    })
    .filter(Boolean);

  if (!items.length) {
    return;
  }

  const setActive = (activeLink) => {
    for (const { link } of items) {
      if (link === activeLink) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  const updateFromScroll = () => {
    const spyLine = Math.max(96, Math.round(window.innerHeight * 0.22));
    const scrollBottom = window.innerHeight + window.scrollY;
    const docHeight = document.documentElement.scrollHeight;
    const atBottom = scrollBottom >= docHeight - 4;

    if (atBottom) {
      setActive(items[items.length - 1].link);
      return;
    }

    let current = items[0];
    for (const item of items) {
      if (item.target.getBoundingClientRect().top <= spyLine) {
        current = item;
      }
    }

    setActive(current.link);
  };

  let ticking = false;
  const onScrollOrResize = () => {
    if (ticking) {
      return;
    }
    ticking = true;
    requestAnimationFrame(() => {
      updateFromScroll();
      ticking = false;
    });
  };

  window.addEventListener("scroll", onScrollOrResize, { passive: true });
  window.addEventListener("resize", onScrollOrResize);
  window.addEventListener("hashchange", updateFromScroll);
  window.addEventListener("load", updateFromScroll);
  updateFromScroll();
}

function setupArchiveFilters() {
  const projectsRoot = document.getElementById("archive-projects");
  const filterRoot = document.querySelector(".archive-filters");
  if (!projectsRoot || !filterRoot) {
    return;
  }

  const projects = projectsRoot.querySelectorAll(
    "article.project[data-archive-category]",
  );
  const buttons = filterRoot.querySelectorAll("button[data-archive-filter]");
  if (!projects.length || !buttons.length) {
    return;
  }

  const applyFilter = (value) => {
    for (const article of projects) {
      const cat = article.getAttribute("data-archive-category");
      const show = value === "all" || cat === value;
      article.hidden = !show;
      article.classList.toggle("is-archive-hidden", !show);
    }

    for (const btn of buttons) {
      const active = btn.dataset.archiveFilter === value;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
  };

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      applyFilter(btn.dataset.archiveFilter);
    });
  }

  applyFilter("all");
}

function setupFeaturedVideos() {
  const videos = Array.from(
    document.querySelectorAll(
      "video.featured-thumbnail, .experience-role-media video",
    ),
  );
  if (!videos.length) {
    return;
  }

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (prefersReducedMotion) {
    for (const video of videos) {
      video.removeAttribute("autoplay");
      video.pause();
    }
    return;
  }

  const prepare = (video) => {
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("preload", "auto");
    video.removeAttribute("controls");
    if ("disableRemotePlayback" in video) {
      video.disableRemotePlayback = true;
    }
  };

  const tryPlay = (video) => {
    prepare(video);
    if (!video.paused && !video.ended) {
      return;
    }
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  };

  const sectionIsShownFor = (video) => {
    const section = video.closest(".reveal-on-scroll");
    if (!section) {
      return true;
    }
    if (section.classList.contains("reveal-pending")) {
      return false;
    }
    return (
      section.classList.contains("is-visible") ||
      !section.classList.contains("reveal-on-scroll")
    );
  };

  const playShown = () => {
    for (const video of videos) {
      if (sectionIsShownFor(video)) {
        tryPlay(video);
      }
    }
  };

  for (const video of videos) {
    prepare(video);
    video.addEventListener("loadeddata", playShown);
    video.addEventListener("canplay", playShown);
  }

  const watchedSections = new Set();
  for (const video of videos) {
    const section = video.closest(".reveal-on-scroll");
    if (!section || watchedSections.has(section)) {
      continue;
    }
    watchedSections.add(section);
    const revealObserver = new MutationObserver(playShown);
    revealObserver.observe(section, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      playShown();
    }
  });

  // Low Power Mode / strict policies: unlock after any gesture.
  const unlockOnGesture = () => {
    for (const video of videos) {
      tryPlay(video);
    }
  };
  document.addEventListener("touchstart", unlockOnGesture, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchend", unlockOnGesture, {
    capture: true,
    passive: true,
  });
  document.addEventListener("click", unlockOnGesture, true);
  document.addEventListener("scroll", unlockOnGesture, {
    capture: true,
    passive: true,
  });

  let attempts = 0;
  const retryId = window.setInterval(() => {
    playShown();
    attempts += 1;
    if (attempts >= 40 || videos.every((v) => !v.paused)) {
      window.clearInterval(retryId);
    }
  }, 250);

  playShown();
}

document.addEventListener("DOMContentLoaded", () => {
  ensureIconSprite();
  setupThemeToggle();
  setupHomeNav();
  setupScrollSpy();
  setupMobileMenu();
  attachIcons();
  setupArchiveFilters();
  setupRevealOnScroll();
  setupFeaturedVideos();
});
