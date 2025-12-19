// ===== Abrar Store Enhanced JavaScript =====
// Version 2.0 - Performance Optimized with Modern Features

// ===== Theme Management =====
(function() {
  const themeToggle = document.getElementById('themeToggle');
  const html = document.documentElement;
  
  // Load saved theme
  const savedTheme = localStorage.getItem('theme') || 'light';
  html.setAttribute('data-theme', savedTheme);
  
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = html.getAttribute('data-theme');
      const newTheme = currentTheme === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      
      // Update icon
      const icon = themeToggle.querySelector('i');
      if (icon) {
        icon.className = newTheme === 'light' ? 'fa fa-moon' : 'fa fa-sun';
      }
    });
  }
})();

// ===== Image Lightbox with Keyboard Support =====
(function(){
  const bg = document.getElementById('imgPreviewBg');
  const im = document.getElementById('imgPreview');
  const x = document.getElementById('imgPreviewClose');
  
  function close() {
    if (bg) bg.style.display = 'none';
    if (im) im.style.display = 'none';
    if (x) x.style.display = 'none';
    document.body.style.overflow = '';
  }
  
  function open(src) {
    if (!im || !bg || !x) return;
    im.src = src;
    bg.style.display = 'block';
    im.style.display = 'block';
    x.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
  
  document.addEventListener('click', e => {
    const t = e.target;
    if (t.classList && t.classList.contains('js-img') && t.src) {
      open(t.src);
    } else if (t === bg || t === x) {
      close();
    }
  });
  
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
})();

// ===== Status Menu Toggle =====
function toggleMenu(el) {
  const menu = el.parentElement.querySelector('.status-menu');
  const open = menu.style.display === 'block';
  document.querySelectorAll('.status-menu').forEach(m => m.style.display = 'none');
  menu.style.display = open ? 'none' : 'block';
}

document.addEventListener('click', (e) => {
  const wrap = e.target.closest('.status-wrap');
  if (!wrap) document.querySelectorAll('.status-menu').forEach(m => m.style.display = 'none');
});

// ===== Modal Management =====
function openModal(id) {
  const modal = document.getElementById(id);
  const bg = document.getElementById(id + '-bg');
  if (modal) modal.classList.add('show');
  if (bg) bg.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const modal = document.getElementById(id);
  const bg = document.getElementById(id + '-bg');
  if (modal) modal.classList.remove('show');
  if (bg) bg.classList.remove('show');
  document.body.style.overflow = '';
}

// ===== Loading Overlay =====
function showLoading() {
  let overlay = document.getElementById('loadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.remove('active');
}

// ===== Notification System =====
function showNotification(message, type = 'success', duration = 3000) {
  const notification = document.createElement('div');
  notification.className = `notification ${type} show`;
  
  const icon = type === 'success' ? 'fa-check-circle' : 
               type === 'error' ? 'fa-exclamation-circle' : 
               'fa-info-circle';
  
  notification.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <i class="fa ${icon}" style="font-size: 1.5rem; color: var(--${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'warning'});"></i>
      <div style="flex: 1;">
        <strong style="display: block; margin-bottom: 4px;">${type === 'success' ? 'نجاح' : type === 'error' ? 'خطأ' : 'تنبيه'}</strong>
        <p style="margin: 0; font-size: 0.9rem;">${message}</p>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; color: var(--text); cursor: pointer; font-size: 1.2rem;">
        <i class="fa fa-times"></i>
      </button>
    </div>
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideInRight 0.3s ease reverse';
    setTimeout(() => notification.remove(), 300);
  }, duration);
}

// ===== Form Auto-save (for draft orders) =====
function enableAutoSave(formId, storageKey) {
  const form = document.getElementById(formId);
  if (!form) return;
  
  // Load saved data
  const savedData = localStorage.getItem(storageKey);
  if (savedData) {
    try {
      const data = JSON.parse(savedData);
      Object.keys(data).forEach(key => {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) input.value = data[key];
      });
    } catch (e) {
      console.error('Error loading saved form data:', e);
    }
  }
  
  // Save on input
  form.addEventListener('input', debounce(() => {
    const formData = new FormData(form);
    const data = {};
    formData.forEach((value, key) => {
      data[key] = value;
    });
    localStorage.setItem(storageKey, JSON.stringify(data));
  }, 1000));
  
  // Clear on submit
  form.addEventListener('submit', () => {
    localStorage.removeItem(storageKey);
  });
}

// ===== Debounce Utility =====
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ===== Lazy Loading Images =====
if ('IntersectionObserver' in window) {
  const imageObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          observer.unobserve(img);
        }
      }
    });
  });
  
  document.querySelectorAll('img[data-src]').forEach(img => {
    imageObserver.observe(img);
  });
}

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + K: Focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const searchInput = document.querySelector('input[type="search"], input[placeholder*="بحث"]');
    if (searchInput) searchInput.focus();
  }
  
  // Ctrl/Cmd + N: New item (context-aware)
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    const addButton = document.querySelector('.btn.add');
    if (addButton) addButton.click();
  }
});

// ===== Table Row Selection =====
function initTableSelection() {
  const selectAll = document.getElementById('selectAll');
  const rowChecks = document.querySelectorAll('.rowCheck');
  
  if (selectAll && rowChecks.length) {
    selectAll.addEventListener('change', () => {
      rowChecks.forEach(check => check.checked = selectAll.checked);
      updateBulkCount();
    });
    
    rowChecks.forEach(check => {
      check.addEventListener('change', updateBulkCount);
    });
  }
}

function updateBulkCount() {
  const checked = document.querySelectorAll('.rowCheck:checked').length;
  const countEl = document.querySelector('.bulk-count');
  if (countEl) countEl.textContent = checked;
  
  const bulkBar = document.querySelector('.bulk-bar');
  if (bulkBar) {
    bulkBar.style.display = checked > 0 ? 'flex' : 'none';
  }
}

// ===== Initialize on DOM Ready =====
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  initTableSelection();
  
  // Add smooth scroll to all anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  
  // Enhance form validation
  document.querySelectorAll('form').forEach(form => {
    form.addEventListener('submit', function(e) {
      const requiredInputs = form.querySelectorAll('[required]');
      let isValid = true;
      
      requiredInputs.forEach(input => {
        if (!input.value.trim()) {
          isValid = false;
          input.style.borderColor = 'var(--danger)';
          setTimeout(() => {
            input.style.borderColor = '';
          }, 2000);
        }
      });
      
      if (!isValid) {
        e.preventDefault();
        showNotification('الرجاء ملء جميع الحقول المطلوبة', 'error');
      }
    });
  });
}

// ===== Export Functions for Global Use =====
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.showNotification = showNotification;
window.openModal = openModal;
window.closeModal = closeModal;
window.toggleMenu = toggleMenu;