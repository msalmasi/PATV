/// <reference path='./both.js' />


function initPlayer() {

    let videoElement = document.querySelector('#videoElement');

   var player = videojs('videoElement', {
   nativeAudioTracks: false,
   nativeVideoTracks: false,
fluid: true,
responsive: true,
   liveui: true,
   muted: true,
   vhs: { overrideNative: true, 
          smoothQualityChange: true, 
         enableLowInitialPlaylist: true }   
   });
   player.play();


    let overlay = document.querySelector('#videoOverlay');
    overlay.onclick = () => {
        overlay.style.display = 'none';
        player.muted(false);
    };
}

window.addEventListener('load', initPlayer);
