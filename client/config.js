window.TIME_BOMB_SERVER_URL =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? window.location.origin
    : 'https://timebomb-6qrl.onrender.com';
