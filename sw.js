// Service worker mínimo — só existe pra habilitar o "instalar app" no Android.
// Não guarda nada em cache de propósito: os dados vêm ao vivo do Supabase,
// então cachear a página ou as respostas da API só causaria tela desatualizada.
self.addEventListener("install", function (e) {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  self.clients.claim();
});
self.addEventListener("fetch", function () {
  // passthrough — deixa o navegador buscar normalmente
});
