const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

function updateAppViewport() {
  const height = tg?.viewportHeight || window.innerHeight;
  document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
}

updateAppViewport();
window.addEventListener("resize", updateAppViewport);
tg?.onEvent("viewportChanged", updateAppViewport);

if (tg) {
  document.documentElement.style.setProperty("--tg-theme-bg-color", tg.themeParams.bg_color);
  document.documentElement.style.setProperty("--tg-theme-text-color", tg.themeParams.text_color);
  document.documentElement.style.setProperty("--tg-theme-secondary-bg-color", tg.themeParams.secondary_bg_color);
  tg.BackButton.hide();
}

let products = [];
const ADMIN_USER_IDS = new Set(["8414885700", "6627701692", "1987944272"]);
const BYN_TO_RUB = 28.5;
const USDT_TO_RUB = 86.0;
const isAdmin = () =>
  !tg ||
  ADMIN_USER_IDS.has(String(tg?.initDataUnsafe?.user?.id || ""));

const categories = ["Все", "Обувь", "Аксессуары", "Худи", "Верхняя одежда", "Штаны / Шорты", "Футболки"];
let activeCategory = "Все";
let searchText = "";
let sortMode = "new";
let priceFrom = null;
let priceTo = null;
const favorites = new Set();
let activePage = "catalog";
let activeProductId = null;
let activeGalleryIndex = 0;
let galleryDirection = 1;
let detailScrollPosition = 0;
let selectedImageFiles = [];

const pageRoot = document.querySelector("#pageRoot");
const detailActionsEl = document.querySelector("#detailActions");

function formatPrice(value) {
  return new Intl.NumberFormat("ru-RU").format(value) + " ₽";
}

function formatByn(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value) + " BYN";
}

function formatUsdt(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value) + " USDT";
}

async function loadProducts() {
  try {
    const response = await fetch("/api/products", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      products = data.products || [];
      renderPage();
    }
  } catch (error) {
    console.error("Не удалось загрузить товары:", error);
  }
}

async function apiRequest(path, options = {}) {
  const initData = tg?.initData || "";
  const adminUserId = tg?.initDataUnsafe?.user?.id || "";
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData,
      "X-Admin-User-Id": adminUserId ? String(adminUserId) : "8414885700",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Ошибка сервера");
  }
  return response.json();
}

async function compressImage(file, maxSize = 1600, quality = 0.82) {
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = reject;
    element.src = source;
  });
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function setupCategoryDrag(categoriesEl) {
  let startX = 0;
  let startScrollLeft = 0;
  let dragging = false;
  let moved = false;

  categoriesEl.addEventListener("pointerdown", event => {
    moved = false;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.pointerType !== "mouse") return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startScrollLeft = categoriesEl.scrollLeft;
    categoriesEl.classList.add("dragging");
  });

  categoriesEl.addEventListener("pointermove", event => {
    if (!dragging) return;
    const distance = event.clientX - startX;
    if (Math.abs(distance) > 4) moved = true;
    categoriesEl.scrollLeft = startScrollLeft - distance;
  });

  const stopDragging = event => {
    if (!dragging) return;
    dragging = false;
    categoriesEl.classList.remove("dragging");
  };

  categoriesEl.addEventListener("pointerup", stopDragging);
  categoriesEl.addEventListener("pointercancel", stopDragging);
  categoriesEl.addEventListener("click", event => {
    const categoryButton = event.target.closest("[data-category]");
    if (categoryButton && !moved) {
      activeCategory = categoryButton.dataset.category;
      renderCategories();
      renderProducts();
      tg?.HapticFeedback?.selectionChanged();
      event.stopPropagation();
      return;
    }
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }
  }, true);

  categoriesEl.addEventListener("wheel", event => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      categoriesEl.scrollLeft += event.deltaY;
    }
  }, { passive: false });
}

function renderCategories() {
  const categoriesEl = document.querySelector("#categories");
  categoriesEl.innerHTML = categories.map(category => {
    const count = category === "Все"
      ? products.length
      : products.filter(product => product.category === category).length;
    const active = category === activeCategory ? "active" : "";
    return `<button class="category ${active}" data-category="${category}" title="${count} товаров" aria-label="${category}: ${count} товаров">${category}</button>`;
  }).join("");
  const activeButton = categoriesEl.querySelector(".category.active");
  activeButton?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  categoriesEl.querySelectorAll("[data-category]").forEach(categoryButton => {
    categoryButton.addEventListener("click", event => {
      event.stopPropagation();
      activeCategory = categoryButton.dataset.category;
      renderCategories();
      renderProducts();
      tg?.HapticFeedback?.selectionChanged();
    });
  });
  setupCategoryDrag(categoriesEl);
}

function renderProducts() {
  const productsEl = document.querySelector("#products");
  const filtered = products.filter(product => {
    const categoryMatches = activeCategory === "Все" || product.category === activeCategory;
    const searchMatches = product.name.toLowerCase().includes(searchText.toLowerCase());
    const price = product.byn || product.price / BYN_TO_RUB;
    const fromMatches = priceFrom === null || price >= priceFrom;
    const toMatches = priceTo === null || price <= priceTo;
    return categoryMatches && searchMatches && fromMatches && toMatches;
  }).sort((a, b) => {
    const aPrice = a.byn || a.price / BYN_TO_RUB;
    const bPrice = b.byn || b.price / BYN_TO_RUB;
    if (sortMode === "cheap") return aPrice - bPrice;
    if (sortMode === "expensive") return bPrice - aPrice;
    return b.id - a.id;
  });

  productsEl.innerHTML = filtered.length ? filtered.map(productCardTemplate).join("") : `<div class="empty-category" style="grid-column:1/-1">
    <img class="empty-category-box" src="drop-box.png" alt="" />
    <span>В категории «${activeCategory}» пока нет товаров</span>
    <strong>Скоро дроп...</strong>
  </div>`;

}

function productCardTemplate(product) {
  const images = Array.isArray(product.images) && product.images.length
    ? product.images
    : [product.image];
  const byn = product.byn || product.price / BYN_TO_RUB;
  const usdt = product.usdt || (product.price / USDT_TO_RUB);
  const rub = product.price || Math.round(byn * BYN_TO_RUB);
  return `
    <article class="product-card" data-open-product="${product.id}" tabindex="0" aria-label="Подробнее: ${product.name}">
      <div class="product-image">
        <span class="product-badge">${product.badge || ""}</span>
        <button class="favorite-button ${favorites.has(product.id) ? "active" : ""}" data-favorite="${product.id}" aria-label="Избранное">${favorites.has(product.id) ? "♥" : "♡"}</button>
        <img src="${images[0]}" alt="${product.name}" />
        ${images.length > 1 ? `<span class="card-gallery-count">${images.length} фото</span>` : ""}
      </div>
      <div class="product-info">
        <div class="product-brand">${product.brand}</div>
        <h3 class="product-name">${product.name}</h3>
        <div class="product-meta">${product.unit}</div>
        <div class="product-bottom">
          <div class="product-card-prices">
            <span class="price">${formatByn(byn)}</span>
            <span class="product-currency">${formatUsdt(usdt)} · ${formatPrice(rub)}</span>
          </div>
        </div>
      </div>
    </article>
  `;
}

function openProductDetail(productId) {
  const product = products.find(item => String(item.id) === String(productId));
  if (!product) return;
  detailScrollPosition = window.scrollY;
  activeProductId = product.id;
  activeGalleryIndex = 0;
  galleryDirection = 1;
  document.body.classList.add("product-detail-open");
  renderProductDetail();
  window.scrollTo({ top: 0 });
  tg?.BackButton.show();
}

function closeProductDetail() {
  activeProductId = null;
  document.body.classList.remove("product-detail-open");
  detailActionsEl.innerHTML = "";
  detailActionsEl.setAttribute("aria-hidden", "true");
  renderPage();
  window.scrollTo({ top: detailScrollPosition });
  tg?.BackButton.hide();
}

function renderProductDetail() {
  const product = products.find(item => String(item.id) === String(activeProductId));
  if (!product) {
    closeProductDetail();
    return;
  }
  const images = Array.isArray(product.images) && product.images.length
    ? product.images
    : [product.image];
  const imageIndex = Math.min(activeGalleryIndex, images.length - 1);
  const byn = product.byn || product.price / BYN_TO_RUB;
  const usdt = product.usdt || (product.price / USDT_TO_RUB);
  const rub = product.price || Math.round(byn * BYN_TO_RUB);
  const measurements = [
    ["Длина", product.measurements?.length],
    ["Ширина", product.measurements?.width],
    ["Длина рукава", product.measurements?.sleeve],
    ["Полуобхват талии", product.measurements?.waist],
  ].filter(([, value]) => value);

  pageRoot.innerHTML = `
    <section class="product-detail">
      <button class="detail-back" data-close-product aria-label="Назад в каталог">‹ <span>Назад</span></button>
      <div class="detail-gallery" data-detail-gallery>
        <img class="detail-gallery-image ${galleryDirection > 0 ? "enter-next" : "enter-previous"}" src="${images[imageIndex]}" alt="${product.name}, фото ${imageIndex + 1}" draggable="false" />
        <button class="favorite-button ${favorites.has(product.id) ? "active" : ""}" data-favorite="${product.id}" aria-label="Избранное">${favorites.has(product.id) ? "♥" : "♡"}</button>
        ${images.length > 1 ? `
          <div class="gallery-dots" aria-label="Фото товара">
            ${images.map((_, index) => `<button class="gallery-dot ${index === imageIndex ? "active" : ""}" data-gallery-index="${index}" aria-label="Фото ${index + 1}" aria-current="${index === imageIndex}"></button>`).join("")}
          </div>
        ` : ""}
      </div>
      <div class="detail-content">
        <div class="product-brand">${product.brand}</div>
        <h1 class="detail-title">${product.name}</h1>
        <div class="detail-prices">
          <strong>${formatByn(byn)}</strong>
          <span>${formatUsdt(usdt)} · ${formatPrice(rub)}</span>
        </div>
        <section class="detail-specs">
          <div><span>Размер</span><strong>${product.unit || "Не указан"}</strong></div>
          <div><span>Состояние</span><strong>${product.condition || "Не указано"}</strong></div>
        </section>
        ${measurements.length ? `
          <section class="detail-measurements">
            <h2>Замеры</h2>
            ${measurements.map(([label, value]) => `<div><span>${label}</span><strong>${value} см</strong></div>`).join("")}
            <p>Перед покупкой сверьте замеры с похожей вещью.</p>
          </section>
        ` : ""}
      </div>
    </section>
  `;
  detailActionsEl.innerHTML = `
    <button data-contact="chkenfs" data-product-contact="${product.id}">Написать продавцу</button>
    ${isAdmin() ? `<button class="detail-delete-button" data-delete-product="${product.id}">Удалить товар</button>` : ""}
  `;
  detailActionsEl.setAttribute("aria-hidden", "false");

  const gallery = pageRoot.querySelector("[data-detail-gallery]");
  let startX = null;
  gallery.addEventListener("pointerdown", event => {
    if (event.isPrimary && event.button === 0) startX = event.clientX;
  });
  gallery.addEventListener("pointerup", event => {
    if (startX === null || Math.abs(event.clientX - startX) < 40) {
      startX = null;
      return;
    }
    galleryDirection = event.clientX < startX ? 1 : -1;
    activeGalleryIndex = (imageIndex + galleryDirection + images.length) % images.length;
    startX = null;
    renderProductDetail();
  });
  gallery.addEventListener("pointercancel", () => {
    startX = null;
  });
}

function openFilters() {
  document.querySelector("#filterPanel").classList.add("open");
  document.querySelector("#filterBackdrop").classList.add("open");
  tg?.HapticFeedback?.selectionChanged();
}

function closeFilters() {
  document.querySelector("#filterPanel").classList.remove("open");
  document.querySelector("#filterBackdrop").classList.remove("open");
}


function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function contactSeller(button) {
  const username = button.dataset.contact || "dkckfkfs";
  const product = products.find(item => String(item.id) === button.dataset.productContact);
  const text = product
    ? `Привет! Интересует товар ${product.brand} ${product.name}, размер ${product.unit}, ${formatByn(product.byn || product.price / BYN_TO_RUB)}.`
    : "Привет! Хотелось бы обсудить индивидуальный заказ.";
  const url = `https://t.me/${username}?text=${encodeURIComponent(text)}`;
  if (tg) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function deleteProduct(productId) {
  const product = products.find(item => String(item.id) === String(productId));
  if (!product || !isAdmin()) return;
  const confirmation = `Удалить товар «${product.name}»?`;
  const confirmed = typeof tg?.showConfirm === "function"
    ? await new Promise(resolve => tg.showConfirm(confirmation, resolve))
    : window.confirm(confirmation);
  if (!confirmed) return;
  const deleteButton = detailActionsEl.querySelector("[data-delete-product]");
  if (deleteButton) deleteButton.disabled = true;
  try {
    await apiRequest("/api/products", {
      method: "POST",
      body: JSON.stringify({ action: "delete", id: product.id }),
    });
    favorites.delete(product.id);
    await loadProducts();
    closeProductDetail();
    showToast("Товар удалён");
  } catch (error) {
    if (deleteButton) deleteButton.disabled = false;
    showToast(error.message || "Не удалось удалить товар");
  }
}

pageRoot.addEventListener("click", event => {
  if (event.target.closest("[data-close-product]")) {
    closeProductDetail();
    return;
  }
  const galleryDot = event.target.closest("[data-gallery-index]");
  if (galleryDot) {
    const nextIndex = Number(galleryDot.dataset.galleryIndex);
    galleryDirection = nextIndex >= activeGalleryIndex ? 1 : -1;
    activeGalleryIndex = nextIndex;
    renderProductDetail();
    return;
  }
  const productCard = event.target.closest("[data-open-product]");
  if (productCard && !event.target.closest("button")) {
    openProductDetail(productCard.dataset.openProduct);
    return;
  }
  if (event.target.closest("#filterButton")) openFilters();

  const favoriteButton = event.target.closest("[data-favorite]");
  if (favoriteButton) {
    const id = Number(favoriteButton.dataset.favorite);
    favorites.has(id) ? favorites.delete(id) : favorites.add(id);
    if (activeProductId !== null) renderProductDetail();
    else renderPage();
    tg?.HapticFeedback?.selectionChanged();
    return;
  }

  if (event.target.closest("[data-go-catalog]")) setPage("catalog");
  const contactButton = event.target.closest("[data-contact]");
  if (contactButton) {
    contactSeller(contactButton);
  }
});

detailActionsEl.addEventListener("click", event => {
  const deleteButton = event.target.closest("[data-delete-product]");
  if (deleteButton) {
    deleteProduct(deleteButton.dataset.deleteProduct);
    return;
  }
  const contactButton = event.target.closest("[data-contact]");
  if (contactButton) contactSeller(contactButton);
});

pageRoot.addEventListener("keydown", event => {
  const productCard = event.target.closest("[data-open-product]");
  if (productCard && !event.target.closest("button") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openProductDetail(productCard.dataset.openProduct);
  }
});

document.querySelector("#filterClose").addEventListener("click", closeFilters);
document.querySelector("#filterBackdrop").addEventListener("click", closeFilters);

document.querySelector("#sortOptions").addEventListener("click", event => {
  const button = event.target.closest("[data-sort]");
  if (!button) return;
  sortMode = button.dataset.sort;
  document.querySelectorAll("#sortOptions button").forEach(item => item.classList.toggle("active", item === button));
});

document.querySelector("#resetFilters").addEventListener("click", () => {
  sortMode = "new";
  priceFrom = null;
  priceTo = null;
  document.querySelector("#priceFrom").value = "";
  document.querySelector("#priceTo").value = "";
  document.querySelectorAll("#sortOptions button").forEach((item, index) => item.classList.toggle("active", index === 0));
  renderPage();
});

document.querySelector("#applyFilters").addEventListener("click", () => {
  const fromValue = document.querySelector("#priceFrom").value;
  const toValue = document.querySelector("#priceTo").value;
  priceFrom = fromValue === "" ? null : Number(fromValue);
  priceTo = toValue === "" ? null : Number(toValue);
  closeFilters();
  renderPage();
  showToast("Фильтры применены");
});

tg?.BackButton.onClick(() => {
  if (activeProductId !== null) closeProductDetail();
});

function catalogTemplate() {
  return `
    <header class="store-header">
      <img src="axe-store.png" alt="AXE STORE" />
      <span>AXE STORE</span>
    </header>
    <h1 class="catalog-title">Каталог</h1>
    <p class="catalog-count">${products.length} вещей в наличии</p>
    ${isAdmin() ? `<button class="admin-add-button" id="openAdminProduct">+ Добавить товар</button>` : ""}
    <div class="catalog-controls">
      <section class="categories" id="categories" aria-label="Категории"></section>
      <button class="filter-button" id="filterButton" aria-label="Фильтры">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4" /></svg>
      </button>
    </div>
    <section class="products"><div class="products-grid" id="products"></div></section>
  `;
}

function favoritesTemplate() {
  return `
    <h1 class="catalog-title simple-title">Избранное</h1>
    ${favorites.size ? `
      <section class="products"><div class="products-grid" id="products"></div></section>
    ` : `
      <section class="empty-state">
        <h2>Пока пусто</h2>
        <p>Нажмите на сердечко у товара, и он появится здесь.</p>
        <button data-go-catalog>Перейти в каталог <span>↗</span></button>
      </section>
    `}
  `;
}

function orderTemplate() {
  return `
    <h1 class="catalog-title simple-title">Под заказ</h1>
    <p class="page-lead">Не нашли нужную вещь в каталоге? Найдём и привезём её под вас.</p>
    <section class="info-card">
      <h2>Индивидуальный заказ</h2>
      <p>Напишите, что ищете. Подберём варианты, согласуем цену и сроки доставки в переписке.</p>
      <button data-contact="chkenfs">Обсудить заказ <span>↗</span></button>
    </section>
    <section class="info-card">
      <h2>Что прислать</h2>
      <ul>
        <li>Бренд и модель</li>
        <li>Размер</li>
        <li>Фото или ссылку на вещь, если есть</li>
        <li>Бюджет, на который рассчитываете</li>
      </ul>
    </section>
  `;
}

function aboutTemplate() {
  return `
    <div class="about-hero">
      <img src="axe-store.png" alt="AXE STORE" />
      <h1>AXE STORE</h1>
      <p>Брендовая одежда, обувь, сумки и аксессуары в наличии. Цены в BYN, USDT и ₽.</p>
    </div>
    <section class="info-card">
      <h2>Как мы работаем</h2>
      <ul>
        <li>Вещи были в употреблении и могут иметь следы носки. Состояние указано у каждого товара.</li>
        <li>Возврата нет, поэтому перед покупкой сверяйте размеры.</li>
      </ul>
    </section>
    <section class="info-card">
      <h2>Доставка</h2>
      <ul>
        <li>Личная встреча в Минске</li>
        <li>Отправка СДЭКом или почтой в любые регионы</li>
      </ul>
    </section>
    <section class="info-card">
      <h2>Связь</h2>
      <button data-contact="chkenfs">Написать @chkenfs <span>↗</span></button>
      <button data-contact="dkckfkfs">Написать @dkckfkfs <span>↗</span></button>
    </section>
  `;
}

function setPage(page) {
  const buttons = [...document.querySelectorAll(".bottom-nav button")];
  const previousIndex = buttons.findIndex(button => button.dataset.page === activePage);
  const index = buttons.findIndex(button => button.dataset.page === page);
  if (page === activePage) return;
  pageRoot.style.setProperty("--page-offset", index >= previousIndex ? "18px" : "-18px");
  activePage = page;
  buttons.forEach(button => button.classList.toggle("active", button.dataset.page === page));
  pageRoot.classList.remove("page-enter");
  void pageRoot.offsetWidth;
  renderPage();
  pageRoot.classList.add("page-enter");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderPage() {
  if (activeProductId !== null) {
    renderProductDetail();
    return;
  }
  if (activePage === "catalog") pageRoot.innerHTML = catalogTemplate();
  if (activePage === "favorites") pageRoot.innerHTML = favoritesTemplate();
  if (activePage === "order") pageRoot.innerHTML = orderTemplate();
  if (activePage === "about") pageRoot.innerHTML = aboutTemplate();
  if (activePage === "catalog") {
    renderCategories();
    renderProducts();
  } else if (activePage === "favorites" && favorites.size) {
    const productsEl = document.querySelector("#products");
    productsEl.innerHTML = products.filter(product => favorites.has(product.id)).map(productCardTemplate).join("");
  }
}

document.querySelectorAll(".bottom-nav [data-page]").forEach(button => {
  button.addEventListener("click", () => setPage(button.dataset.page));
});

const adminPanel = document.querySelector("#adminPanel");
const adminBackdrop = document.querySelector("#adminBackdrop");
const adminForm = document.querySelector("#adminProductForm");

function closeAdmin() {
  adminPanel.classList.remove("open");
  adminBackdrop.classList.remove("open");
}

function setAdminStatus(message, isError = false) {
  const status = document.querySelector("#adminFormStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

pageRoot.addEventListener("click", event => {
  if (event.target.closest("#openAdminProduct")) {
    adminPanel.classList.add("open");
    adminBackdrop.classList.add("open");
  }
});

document.querySelector("#adminClose").addEventListener("click", closeAdmin);
adminBackdrop.addEventListener("click", closeAdmin);

adminForm.elements.byn.addEventListener("input", () => {
  const byn = Number(adminForm.elements.byn.value) || 0;
  const rub = Math.round(byn * BYN_TO_RUB);
  document.querySelector("#bynPreview").textContent = formatByn(byn);
  document.querySelector("#rubPreview").textContent = formatPrice(rub);
  document.querySelector("#usdtPreview").textContent = formatUsdt(Math.round((rub / USDT_TO_RUB) * 100) / 100);
});

adminForm.elements.images.addEventListener("change", () => {
  const preview = document.querySelector("#imagePreview");
  const pickerText = document.querySelector("#photoPickerText");
  const selection = document.querySelector("#photoSelection");
  const input = adminForm.elements.namedItem("images");
  const newFiles = [...input.files];
  const availableSlots = 10 - selectedImageFiles.length;
  selectedImageFiles.push(...newFiles.slice(0, availableSlots));
  input.value = "";
  pickerText.textContent = selectedImageFiles.length ? "Добавить фотографии" : "Выбрать фотографии";
  selection.textContent = selectedImageFiles.length
    ? `Выбрано фотографий: ${selectedImageFiles.length} из 10`
    : "Фото ещё не выбраны";
  const exceededLimit = newFiles.length > availableSlots;
  setAdminStatus(exceededLimit ? "Можно загрузить не больше 10 фото." : "", exceededLimit);

  Promise.all(selectedImageFiles.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  }))).then(previews => {
    preview.innerHTML = previews.map((src, index) => `
      <div class="image-preview-item">
        <img src="${src}" alt="Фото ${index + 1}" />
        <button type="button" data-remove-image="${index}" aria-label="Убрать фото ${index + 1}">×</button>
      </div>
    `).join("");
  }).catch(error => {
    console.error("Не удалось показать выбранные фотографии:", error);
    setAdminStatus("Не удалось прочитать одну из фотографий.", true);
  });
});

document.querySelector("#imagePreview").addEventListener("click", event => {
  const removeButton = event.target.closest("[data-remove-image]");
  if (!removeButton) return;
  selectedImageFiles.splice(Number(removeButton.dataset.removeImage), 1);
  adminForm.elements.namedItem("images").dispatchEvent(new Event("change"));
});

adminForm.addEventListener("submit", async event => {
  event.preventDefault();
  const submitButton = adminForm.querySelector(".admin-submit");
  const files = [...selectedImageFiles];
  if (!files.length) {
    setAdminStatus("Выбери хотя бы одно фото кнопкой «Выбрать фотографии».", true);
    return;
  }
  submitButton.disabled = true;
  try {
    const images = [];
    for (const [index, file] of files.entries()) {
      setAdminStatus(`Загружаю фото ${index + 1} из ${files.length}…`);
      const dataUrl = await compressImage(file);
      const uploaded = await apiRequest("/api/upload", {
        method: "POST",
        body: JSON.stringify({ image: dataUrl }),
      });
      images.push(uploaded.url);
    }
    setAdminStatus("Сохраняю товар…");
    const formData = new FormData(adminForm);
    const byn = Number(formData.get("byn"));
    const rub = Math.round(byn * BYN_TO_RUB);
    const product = {
      id: Date.now(),
      name: String(formData.get("name")).trim(),
      brand: String(formData.get("brand")).trim(),
      category: String(formData.get("category")),
      unit: String(formData.get("unit")).trim(),
      condition: String(formData.get("condition")).trim(),
      byn,
      rub,
      usdt: Math.round((rub / USDT_TO_RUB) * 100) / 100,
      measurements: {
        length: formData.get("length"),
        width: formData.get("width"),
        sleeve: formData.get("sleeve"),
        waist: formData.get("waist"),
      },
      price: rub,
      images,
      image: images[0],
      badge: "Новинка",
    };
    await apiRequest("/api/products", {
      method: "POST",
      body: JSON.stringify({ product }),
    });
    adminForm.reset();
    selectedImageFiles = [];
    document.querySelector("#imagePreview").innerHTML = "";
    document.querySelector("#photoPickerText").textContent = "Выбрать фотографии";
    document.querySelector("#photoSelection").textContent = "Фото ещё не выбраны";
    await loadProducts();
    setAdminStatus("");
    closeAdmin();
    showToast("Товар добавлен");
  } catch (error) {
    setAdminStatus(error.message || "Не удалось добавить товар. Проверь соединение и попробуй ещё раз.", true);
  } finally {
    submitButton.disabled = false;
  }
});

loadProducts();
renderPage();
