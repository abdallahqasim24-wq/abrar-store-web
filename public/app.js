
// Simple modal toggler
function openModal(id){ document.getElementById(id)?.classList.add('show'); document.getElementById(id+'-bg')?.classList.add('show'); }
function closeModal(id){ document.getElementById(id)?.classList.remove('show'); document.getElementById(id+'-bg')?.classList.remove('show'); }
