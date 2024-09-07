document.getElementById('uploadForm').addEventListener('submit', function(event) {
    event.preventDefault();
    const formData = new FormData();
    formData.append('avatar', document.getElementById('avatarFile').files[0]);

    fetch(`/api/u/${username}/update/avatar`, {
        method: 'POST',
        body: formData
    })
    .then(response => {
        if (!response.ok) { // Handle non-200 responses
            throw new Error('Failed to upload avatar.');
        }
        return response.json();
    }).then(data => {
        const message = data.message;
        console.log(message);
        if (message.includes("successfully")) { // Check that the spin actually happened / is not in progress. Don't update spinId if so.
        document.getElementById('uploadStatus').style.visibility = 'hidden'; // Remove the animation element after it completes
        document.getElementById('uploadStatus').textContent = 'Avatar edited successfully.'; // Display error message
        document.getElementById('uploadStatus').style.visibility = 'visible'; // Make the status message visible
        setTimeout(() => {
            document.getElementById('uploadStatus').style.visibility = 'hidden'; // Remove the animation element after it completes
    }, 2000); 
        }
    })
    .catch(error => {
        console.error('Error making the POST request:', error);
        document.getElementById('uploadStatus').textContent = 'Class change failed. Check the username.'; // Display error message
        document.getElementById('uploadStatus').style.visibility = 'visible'; // Make the status message visible
        setTimeout(() => {
            document.getElementById('uploadStatus').style.visibility = 'hidden'; // Remove the animation element after it completes
    }, 2000); 
    });
});